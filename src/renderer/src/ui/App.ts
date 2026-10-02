import type { ClaudeStatus, ClaudeUsage, EmberConfig, GitStatus, SessionBrief, ThemeConfig, TurnMessage } from '@shared/types'
import type { OverviewChoice, OverviewOrch, OverviewRow } from './Overview'
import { Group } from '../core/Group'
import { loadFont } from '../core/fonts'
import { Session } from '../core/Session'
import { Spring } from '../motion/spring'
import { ticker } from '../motion/ticker'
import { FocusRing } from './FocusRing'
import { Palette, type Command } from './Palette'
import { helpText, matchCli, type CommandSpec } from './Commands'
import { Search } from './Search'
import { Settings, SETTINGS_TABS, type SettingsTab } from './Settings'
import { FontPicker } from './FontPicker'
import { Cheatsheet } from './Cheatsheet'
import { Sidebar, type CardModel, type Place } from './Sidebar'
import { Remote } from './Remote'
import { PairSheet } from './PairSheet'
// @ts-expect-error - plain ES shared verbatim with the phone bundle
import { parseAccountUrl } from '../../../../resources/relay/protocol.js'
import { Orchestrator, type Turn } from './Orchestrator'
import type { PanelHooks } from './Panel'
import { Vitals } from './Vitals'
import { TitleBar } from './TitleBar'
import { quality } from '../motion/quality'
import { sound } from '../motion/sound'
import { drawMascot } from './Mascot'
import { Onboarding } from './Onboarding'
import { AGENTS } from '@shared/agents'
import type { ActivityState, AttentionKind } from '../core/Activity'

/**
 * Owns the session groups, the sidebar, and the switch transition.
 *
 * Motion is spring-driven from the shared ticker rather than CSS transitions. A
 * duration-and-curve transition always plays the same scripted arc; a spring carries
 * velocity, so flicking through sessions feels like moving weight instead of
 * replaying an animation, and the slight under-damping is what reads as "bubbly".
 */
export class App {
  /** How often session state is recomputed. Fast enough to feel live, cheap enough to ignore. */
  private static readonly ACTIVITY_HZ = 5
  /** Matches GIT_TTL_MS in main/project.ts — asking faster only re-reads its cache. */
  private static readonly GIT_POLL_MS = 4000
  /** Minimum gap between attention chimes for the same session. */
  private static readonly ATTENTION_COOLDOWN_MS = 60_000

  private readonly root: HTMLElement
  private readonly stack: HTMLElement
  private readonly fx: HTMLElement
  private readonly sidebar: Sidebar
  private readonly vitals: Vitals
  private readonly titleBar: TitleBar
  private readonly orchestrator: Orchestrator
  private readonly remote: Remote
  private readonly pairSheet: PairSheet
  /** False without an OpenAI key, which hides the call button. */
  private readonly palette: Palette
  private readonly search: Search
  private readonly focusRing: FocusRing
  private readonly settings: Settings
  private readonly cheatsheet: Cheatsheet
  private readonly groups: Group[] = []
  private activeId: string | null = null
  private activityTimer: number | null = null

  private paneUnsub: (() => void) | null = null
  /** When the motion loop started and last ran a frame; the watchdog reads both. */
  private motionStartedAt = 0
  private lastMotionAt = 0
  /** The left column's width at rest. Layout is set from it once per change, never per frame. */
  private columnW = 0
  /**
   * The slide that follows a column change. Layout jumps to its final state in one frame;
   * these springs carry the sidebar and the stage from where they were to where they now
   * are, as transforms the compositor animates without any further layout. See setColumn.
   */
  private readonly shifts = {
    sidebar: new Spring(0, { stiffness: 460, damping: 1.0, epsilon: 0.3 }),
    stack: new Spring(0, { stiffness: 460, damping: 1.0, epsilon: 0.3 }),
  }
  /**
   * The sidebar's own width during a column change. The grid track jumps to its final
   * width in one frame so the stage lays out once; the sidebar element then animates its
   * width from old to new on top of that track — overflowing it or leaving it short for
   * a few frames, always in step with the stage sliding beside it. Only the sidebar's own
   * subtree lays out per frame, which is a few cards.
   */
  private readonly sidebarWidth = new Spring(0, { stiffness: 460, damping: 1.0, epsilon: 0.3 })
  private shifting = false
  /** The left column's width while it shows the orchestrator: a conversation needs more than a list. */
  private static readonly ORCH_COLUMN_PX = 372
  /**
   * The orchestrator's width, as a real grid column rather than an overlay.
   *
   * It started as a drawer floating over everything, which read fine until a tab had its
   * visualisation panel open too — then the two occupied the same strip of screen and the
   * panel was simply buried. Giving it a column makes the stage narrower instead, so the
   * terminal and the panel share what is left. Same spring as the sidebar, so both edges
   * of the window move with the same weight.
   */
  private readonly ambient = new Spring(0, { stiffness: 90, damping: 1, epsilon: 0.002 })

  /**
   * A whole tab built ahead of time, so opening one is an adoption rather than a build.
   *
   * The first version prepared a spare *terminal* and moved its element into a new tab's
   * slot. Profiled, that still cost a 130ms frame — none of it in our code. Reparenting
   * a canvas that carries a WebGL context makes Chromium rebuild the compositor layer and
   * the GPU resources behind a 2300x1400 surface. So nothing is moved any more: the spare
   * is a complete Group, already in the stack and already composited (invisible, since it
   * is not in `groups`), with its terminal prepared inside it. newGroup adopts it in place
   * and only the shell is left to spawn.
   */
  private spare: { group: Group; session: Session } | null = null
  /** When a key was last pressed anywhere in the window; the spare is built only in quiet. */
  private lastInputAt = 0
  /** What the stack shows with no tab in it: a way back in, rather than the window closing. */
  private readonly emptyEl: HTMLElement
  /** Send typed input to every pane in the active group. */
  private broadcasting = false
  /** Whether off-screen tabs leave layout (see applyPaneStyles). Probe-switchable for A/B. */
  private parking = true
  private readonly shellHistory: string[] = []
  /** Built-in palettes, fetched once — the list is static for the life of the process. */
  private themes: ThemeConfig[] | null = null
  private notifiedGroups = new Map<string, number>()
  /** Said once per run, not once per config reload. */
  /** cwd -> git status, refreshed on the activity tick. */
  private readonly gitByCwd = new Map<string, GitStatus | null>()
  /** What each tab's Claude session last said through its status line, by tab id. */
  private readonly claudeByTab = new Map<string, ClaudeStatus>()
  /** The plan's usage windows, for the overview's numbers. */
  private plan: ClaudeUsage | null = null
  /** Open items on the todo list, for the sidebar's Todo button. */
  private todoOpen = 0
  /**
   * The session tab you were last in before going to a place (overview, todo, notes,
   * map). The shortcut that took you there takes you back to it.
   */
  private lastSessionId: string | null = null
  /** What each tab's Claude session last said and is doing, from its transcript, by tab id. */
  private readonly briefByTab = new Map<string, SessionBrief>()
  private lastGitAt = 0
  private gitPending = new Set<string>()

  constructor(private config: EmberConfig) {
    this.root = document.createElement('div')
    this.root.className = 'ember-root'

    this.columnW = config.window.sidebarWidth

    this.titleBar = new TitleBar(() => this.toggleSidebar(), {
      onPanel: () => this.togglePanel(),
      onVisualize: () => this.visualizeHere(),
    })
    this.sidebar = new Sidebar({
      onOrchestrator: () => this.toggleOrchestrator(),
      onSelect: (id) => void this.activate(id),
      onClose: (id) => this.closeGroup(id),
      onNew: () => void this.newGroup(),
      onRename: (id, title) => this.renameGroup(id, title),
      onReorder: (ids) => this.reorderGroups(ids),
      onPlace: (place) => void this.goPlace(place),
    })

    // The vitals line, pinned at the very bottom of the sidebar.
    this.vitals = new Vitals()
    this.sidebar.el.append(this.vitals.el)

    this.stack = document.createElement('main')
    this.stack.className = 'ember-stack'

    // Static CRT-ish layers (scanlines, vignette) plus one reactive glow. This is an
    // overlay, not true bloom: xterm's WebGL context has no preserveDrawingBuffer, so
    // its framebuffer cannot be read back and post-processed without patching xterm.
    this.fx = document.createElement('div')
    this.fx.className = 'ember-fx'
    this.stack.appendChild(this.fx)

    this.search = new Search({
      next: (q) => this.activeGroup?.focused?.findNext(q) ?? false,
      previous: (q) => this.activeGroup?.focused?.findPrevious(q) ?? false,
      clear: () => this.activeGroup?.focused?.clearSearch(),
      onClose: () => this.activeGroup?.focused?.focus(),
    })
    this.stack.appendChild(this.search.el)

    // Closing the last tab used to close the window. A cleared desk is a state now, not
    // an exit: the stack shows this until the next session, and the sidebar keeps its
    // header, so "+" and every shortcut still work.
    this.emptyEl = document.createElement('div')
    this.emptyEl.className = 'ember-empty'
    this.emptyEl.hidden = true
    const emptyTitle = document.createElement('h2')
    emptyTitle.textContent = 'No sessions'
    const emptyNew = document.createElement('button')
    emptyNew.className = 'ember-empty-new'
    emptyNew.textContent = 'New session'
    emptyNew.addEventListener('click', () => void this.newGroup())
    const emptyHint = document.createElement('p')
    emptyHint.innerHTML =
      '<kbd>Ctrl+Shift+T</kbd> new session &nbsp;·&nbsp; <kbd>Ctrl+K</kbd> palette &nbsp;·&nbsp; <kbd>Ctrl+Shift+D</kbd> todo'
    this.emptyEl.append(emptyTitle, emptyNew, emptyHint)
    this.stack.appendChild(this.emptyEl)

    this.focusRing = new FocusRing(this.stack)

    // Settings edit the file, not the running app: the existing watcher applies it,
    // so the panel is exactly as powerful as hand-editing and cannot drift from it.
    this.settings = new Settings(
      (next) => window.ember.saveConfig(next),
      (command, title) => void this.runInNewTab(command, title),
    )
    this.cheatsheet = new Cheatsheet()

    // The other way in. Same agent, same conversation — this one works in a room with
    // other people in it, which the call does not.
    this.orchestrator = new Orchestrator({
      onSend: async (text) => void (await this.sendToOrchestrator(text)),
      onClose: () => this.toggleOrchestrator(),
    })
    this.sidebar.mountBelowCards(this.orchestrator.el)

    // The third front end. Everything it hands us is routed into the same two methods the
    // panel and the call already use, which is what keeps it one agent rather than three.
    this.remote = new Remote({
      onText: (text) => this.sendToOrchestrator(text),
      onTool: (name, args) => this.runVoiceTool(this.activeId ?? '', name, args),
      onSpoken: (who, text) => this.rememberSpoken({ who, text }),
      onPanelAct: (text, submit) => {
        // Routed to the tab the phone is acting on, which is the active one — the same
        // place the desk's own panel buttons land.
        const group = this.activeGroup
        if (group) this.sendToSession(group, text, submit)
      },
      recap: () => this.recentConversation(),
      onChange: () => {
        this.syncVoiceChrome()
        this.pairSheet.tick()
      },
    })

    this.pairSheet = new PairSheet({
      onCreate: async () => {
        const fresh = await window.ember.remote.create()
        await this.remote.start(fresh)
        return fresh
      },
      onJoin: async (_relay, code) => {
        const parsed = parseAccountUrl(code)
        if (!parsed) return null
        const joined = await window.ember.remote.join(parsed.relay, parsed.key)
        await this.remote.start(joined)
        return joined
      },
      onRename: async (name) => {
        const next = await window.ember.remote.rename(name)
        // Reconnected because the name is announced on connect — the roster the other
        // devices hold is otherwise the old one until this machine next drops.
        if (next) await this.remote.start(next)
      },
      onLeave: async () => {
        await window.ember.remote.leave()
        await this.remote.start(null)
      },
      onRead: () => window.ember.remote.account(),
      status: () => ({
        joined: this.remote.joined,
        linked: this.remote.state === 'online',
        devices: this.remote.devices,
      }),
    })
    this.root.appendChild(this.pairSheet.el)

    this.root.append(this.titleBar.el, this.sidebar.el, this.stack)
    document.body.appendChild(this.root)

    sound.configure(config.sound)
    quality.setEnabled(config.effects.adaptive)

    // Launch: the window scales and fades up rather than popping into existence.
    document.body.classList.add('is-launching')
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('is-launching')))

    this.palette = new Palette((q) => this.buildCommands(q))

    this.applyCssVars()
    this.wireGlobalKeys()
    this.wirePty()
    this.wirePanel()
    this.wireVoice()
    this.wireConfigReload()
    this.exposeDiagnostics()

    this.activityTimer = window.setInterval(() => this.syncTabs(), 1000 / App.ACTIVITY_HZ)
    window.addEventListener('keydown', () => (this.lastInputAt = performance.now()), { capture: true, passive: true })

    // Coming back to the window should put the caret back in the terminal, not
    // wherever the browser last parked focus — unless an input is deliberately open.
    // The orchestrator's width is a share of the window, so a resize has to re-aim it.

    window.addEventListener('focus', () => {
      if (this.palette.isOpen || this.search.isOpen) return
      if (document.querySelector('.ember-card-rename')) return
      this.activeGroup?.focusFirst()
    })
  }

  private get allSessions(): Session[] {
    return this.groups.flatMap((g) => g.panes)
  }

  private get activeGroup(): Group | null {
    return this.groups.find((g) => g.id === this.activeId) ?? null
  }

  private exposeDiagnostics(): void {
    ;(window as unknown as Record<string, unknown>)['__ember'] = {
      // Tab control, so a probe can assert what happens when you switch away from a
      // narrating session rather than only what happens while looking at it.
      // The id, not the Group: a probe that evaluates this by value would otherwise
      // serialise the whole tab — terminal, springs, DOM — and time its own 130ms doing so.
      newTab: () => this.newGroup().then((g) => g.id),
      openNotes: (noteId?: string) => this.newNoteGroup(noteId),
      openTodo: () => this.openTodoIn(this.activeGroup),
      closeTab: (id: string) => this.closeGroup(id),
      activate: (id: string) => this.activate(id),
      activeTab: () => this.activeId,
      /** A session's xterm, for a probe that needs to write to it or read its buffer. */
      term: (id: string) => this.allSessions.find((s) => s.id === id)?.term ?? null,
      sessions: () =>
        this.allSessions.map((s) => ({
          id: s.id,
          cols: s.term.cols,
          rows: s.term.rows,
          bytesIn: s.bytesIn,
          bells: s.bells,
          agent: s.activity.current.agent,
          rawTitle: s.rawTitle,
          title: s.title,
          cwd: s.cwd,
          bufferType: s.bufferType(),
          viewportY: s.term.buffer.active.viewportY,
          blocks: s.blocks.all.length,
          urls: [...s.urls],
          unread: s.unread,
          activity: s.activity.current,
          outcome: s.outcome,
          sinceOutputMs: Math.round(performance.now() - s.lastOutputAt),
          paneW: s.el.clientWidth,
          paneH: s.el.clientHeight,
          text: s.dumpViewport(),
        })),
      groups: () =>
        this.groups.map((g) => ({
          id: g.id,
          panes: g.panes.map((p) => p.id),
          split: g.isSplit,
          zoomed: g.zoomed,
          focused: g.focused?.id ?? null,
        })),
      activeId: () => this.activeId,
      /** Collapse or expand the sidebar, for the chrome probe. */
      sidebar: () => this.toggleSidebar(),
      broadcasting: () => this.broadcasting,
      /** The phone link: whether it is up, whether the phone is there, what it has done. */
      remote: () => ({
        ...this.remote.stats,
        state: this.remote.state,
        joined: this.remote.joined,
        deviceId: this.remote.account?.deviceId ?? '',
        devices: this.remote.devices,
        phoneHere: this.remote.phones.length > 0,
      }),
      /** Drop the link without restarting the app, so revocation can be observed. */
      remoteStop: () => this.remote.stop(),
      /** Start an account without the sheet, so a probe can drive the wire end to end. */
      pairNow: async () => {
        const fresh = await window.ember.remote.create()
        await this.remote.start(fresh)
        return fresh
      },
      /** What the call controls are actually showing right now. */
      callChrome: () => ({
        button: document.querySelector('.ember-orch-call')?.textContent ?? '',
        pill: document.querySelector('.ember-orch-pill')?.textContent ?? '',
        markOnCall: document.querySelector('.ember-voicetoggle.is-orch')?.classList.contains('is-oncall') ?? false,
      }),
      /**
       * Drive the written half without opening the panel.
       *
       * The claim worth checking is not that a chat box exists — it is that typing runs
       * the same tools and lands in the same conversation as talking, which is only
       * observable from outside the panel.
       */
      write: async (text: string) => {
        await this.sendToOrchestrator(text)
        return this.turns.slice(-4).map((t) => `${t.who}: ${t.text}`)
      },
      /** The shared conversation — the thing both channels read and write. */
      thread: () => ({
        turns: this.turns.map((t) => ({ who: t.who, text: t.text.slice(0, 200), spoken: !!t.spoken })),
        history: this.history.length,
        open: this.orchestrator.isOpen,
      }),
      orchestrator: () => this.toggleOrchestrator(),
      /**
       * Run one `ask_claude` round trip without a microphone.
       *
       * This is the join between the two loops, and it is the part that cannot be
       * checked by looking: it types into a real Claude session and reads the answer back
       * off the transcript. A probe can drive it; a person with a headset cannot tell a
       * working bridge from a lucky one.
       */
      ask: (question: string) => this.askClaude(this.activeId ?? '', question),
      /**
       * Call one of the voice's tools without a microphone.
       *
       * The orchestration is the part a person on a headset genuinely cannot check: that
       * `send_work` returns in milliseconds rather than blocking, and that the hand-off
       * reports back by itself, are both invisible from inside a conversation.
       */
      tool: (name: string, args: Record<string, unknown>) =>
        this.runVoiceTool(this.activeId ?? '', name, args ?? {}),
      /** Drive the active card's status line, for watching the digits roll on demand. */
      setCardStatus: (text: string) => this.sidebar.pinStatus(this.activeId ?? '', text),
      /**
       * The panels, and where a dictated sentence would go right now.
       *
       * The last of those is the only way to check the routing at all: focus inside
       * the panel belongs to a different process, so nothing about it is visible from
       * this document except the flag the panel keeps.
       */
      panels: () =>
        this.groups.map((g) => ({
          id: g.id,
          open: g.panel?.isOpen ?? false,
          hasContent: g.panel?.hasContent ?? false,
          picking: g.panel?.isPicking ?? false,
        })),
      /**
       * Draw the mascot in an arbitrary state, for looking at the poses without having
       * to reproduce the session state that causes them (scripts/probe-mascot.mjs).
       * The sprite is the only thing that says what a session is doing, so it is worth
       * being able to see all of it at once.
       */
      mascot: (state: ActivityState, attention: AttentionKind | null, t: number, size = 96) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) return ''
        drawMascot(ctx, size, { state, attention }, t, 0)
        return canvas.toDataURL()
      },
      /**
       * The live Session object, for the latency probe. It hooks the terminal's own
       * onData/onWriteParsed to time a keystroke against its echo, which no summary can
       * stand in for. Probe-only: nothing in the app reaches a session this way.
       */
      session: (id?: string) => (id ? this.allSessions.find((s) => s.id === id) : this.activeGroup?.focused) ?? null,
      loopLag: () => window.ember.diag.loop(),
      setParking: (on: boolean) => {
        this.parking = on
        this.applyPaneStyles()
      },
      /** A real panel on the active tab, for the frame probe. */
      pushPanel: (title: string, content: string, format = 'markdown') =>
        window.ember.diag.pushPanel({ tabId: this.activeId ?? '', title, content, format, replace: true }),
      togglePanel: () => this.togglePanel(),
      spareReady: () => this.spare !== null,
      lastEntrance: () => this.lastEntrance,
      /** Tabs that exist in the DOM, including the spare, so a probe can see the warm one. */
      domTabs: () => document.querySelectorAll('.ember-group').length,
      openPalette: (prefill?: string) => this.palette.show(prefill ?? ''),
      openSearch: () => this.search.show(),
      beginRename: () => this.beginRename(),
      config: () => this.config,
      openSettings: () => this.settings.toggle(this.config),
      toggleCheatsheet: () => this.cheatsheet.toggle(),
      toggleZen: () => this.toggleZen(),
      blocks: () => (this.activeGroup?.focused?.blocks.all ?? []).map((b) => ({ ...b })),
      jumpCommand: (dir: 1 | -1) => this.jumpCommand(dir),
      writeTo: (index: number, text: string) => {
        const s = this.groups[index]?.focused
        if (!s) return false
        ;(s.term as unknown as { input(d: string, u?: boolean): void }).input(text, true)
        return true
      },
      scrollbackText: () =>
        this.allSessions
          .map((s) => {
            const buf = s.term.buffer.active
            const lines: string[] = []
            for (let r = 0; r < buf.baseY + s.term.rows; r++) {
              lines.push(buf.getLine(r)?.translateToString(true) ?? '')
            }
            return lines.join('\n')
          })
          .join('\n'),
      /** Drive xterm's real input path, so probes hit the same handlers as typing. */
      type: (text: string) => {
        const s = this.activeGroup?.focused
        if (!s) return false
        ;(s.term as unknown as { input(data: string, wasUserInput?: boolean): void }).input(text, true)
        return true
      },
      split: (dir: 'row' | 'column') => void this.splitActive(dir),
      toggleZoom: () => this.toggleZoom(),
      copyLastOutput: () => this.copyLastOutput(),
      cursorState: () => this.activeGroup?.focused?.cursorState() ?? null,
      forceCursorFocus: (v: boolean) => this.allSessions.forEach((s) => s.forceCursorFocus(v)),
      setCursorColor: (css: string, style?: string) => {
        for (const s of this.allSessions) {
          s.term.options.theme = { ...s.term.options.theme, cursor: css }
          if (style) s.term.options.cursorStyle = style as never
        }
        return css
      },
    }
  }

  private applyCssVars(): void {
    document.body.classList.toggle('labs-off', !this.config.labs?.enabled)
    const s = document.documentElement.style
    const { motion, theme, window: win, font, effects } = this.config
    const scale = motion.scale
    s.setProperty('--m-tab-switch', `${Math.round(motion.tabSwitchMs * scale)}ms`)
    s.setProperty('--m-pane-spawn', `${Math.round(motion.paneSpawnMs * scale)}ms`)
    s.setProperty('--m-switch-blur', `${motion.switchBlur}px`)
    s.setProperty('--c-bg', theme.background)
    s.setProperty('--c-fg', theme.foreground)
    s.setProperty('--c-accent', theme.cursor)
    s.setProperty('--c-dim', theme.brightBlack)
    s.setProperty('--c-sel', theme.selectionBackground)
    // Windows Terminal's `opacity` is a percentage over the system backdrop; the
    // window itself is transparent, so the tint lives on the content layer.
    s.setProperty('--c-tint-alpha', String(win.opacity / 100))
    // A window with no system backdrop is transparent for real, which also means
    // Windows stops drawing its rounded corners for us — the shell has to round
    // itself instead. See the comment in main/window.ts for why that trade is made.
    document.body.classList.toggle('is-glass', win.material === 'none')
    // One font for the window: the chrome follows the terminal font unless the
    // interface font is deliberately set to something else.
    s.setProperty('--term-font', font.family)
    s.setProperty('--ui-font', font.uiFamily || font.family)
    // Writing surfaces (notes, the todo list) follow the terminal's size, not a fixed one.
    s.setProperty('--app-size', `${font.size}px`)
    s.setProperty('--sidebar-w', `${win.sidebarWidth}px`)
    s.setProperty('--fx-glow', String(effects.glow))
    s.setProperty('--fx-scanlines', String(effects.scanlines))
    s.setProperty('--fx-vignette', String(effects.vignette))
    // A full-window layer the compositor blends on every frame, for gradients whose
    // strength is zero. When every effect is off the layer does not exist.
    this.fx.style.display = effects.glow || effects.scanlines || effects.vignette || effects.ambient ? '' : 'none'
  }

  private wireConfigReload(): void {
    window.ember.onConfigChange((config) => {
      const fontChanged = config.font.family !== this.config.font.family
      this.config = config
      sound.configure(config.sound)
      quality.setEnabled(config.effects.adaptive)
      this.applyCssVars()
      this.setColumn(this.columnWidth())
      this.settings.sync(config)

      for (const g of this.groups) this.tuneGroup(g)

      const apply = () => {
        for (const s of this.allSessions) s.applyConfig(config)
        this.dropSpare()
        this.startPaneMotion()
      }
      // A font picked in settings is very likely one nothing has drawn yet, and
      // xterm sizes its grid from the cell it measures — so let the face resolve
      // before the panes refit, or the first fit lands on the fallback's metrics.
      if (fontChanged) void loadFont(config.font.family, config.font.weight, config.font.size).then(apply)
      else apply()
    })
  }

  /**
   * Every launch opens one new shell.
   *
   * Ember used to rebuild the previous layout and replay each pane's saved scrollback
   * above its fresh prompt. Both are gone. The replay could only be keyed by layout
   * position — pane ids are regenerated every run — so what came back was whatever text
   * had been in that slot last time, which is not the tab you remember being there; and
   * it was text with no live session behind it, so scrolling up reached output whose
   * shell had exited and whose directory may no longer exist. It looked like history and
   * was not.
   */
  async boot(): Promise<void> {
    await this.newGroup()
    this.scheduleSpare()
    if (!this.config.agent.onboarded) window.setTimeout(() => this.showOnboarding(), 600)
  }

  /** The welcome: which agent CLI, how it looks, the keys worth knowing. */
  private showOnboarding(): void {
    new Onboarding({
      config: () => this.config,
      save: (next) => {
        // Applied here as well as on disk, so the next step reads what this one chose
        // without waiting for the watcher's round trip.
        this.config = next
        window.ember.saveConfig(next)
      },
      themes: () => this.loadThemes(),
      runInTab: (command, title) => void this.runInNewTab(command, title),
      onDone: (launch) => {
        const s = this.activeGroup?.focused
        if (launch && s) window.ember.write(s.id, `${AGENTS[launch].bin}\r`)
        this.flashToast('Ctrl+K for everything · F1 for the keys')
      },
    }).show()
  }

  /** Open a tab and run one command in it, in the open — installs and sign-ins. */
  private async runInNewTab(command: string, title: string): Promise<void> {
    const group = await this.newGroup()
    group.customTitle = title.slice(0, 40)
    this.syncTabs()
    const s = group.focused
    // Give the shell its prompt first; typed-ahead input survives, but a profile that
    // clears the screen on start would wipe the command from view.
    if (s) window.setTimeout(() => window.ember.write(s.id, `${command}\r`), 700)
  }

  /**
   * Collapse the sidebar to a rail, rather than away.
   *
   * It used to fade to nothing, which reclaimed the width and took every session with it —
   * so the only way to see what was running was to bring the whole thing back. Minimised
   * keeps the cards, their activity and their badges, and drops only the names, which is
   * the part that costs the width.
   */
  private toggleSidebar(): void {
    document.body.classList.toggle('sidebar-mini')
    this.setColumn(this.columnWidth())
    // The cards lay themselves out differently once the names are gone.
    this.syncTabs()
  }

  /** Wide enough for a badge and its padding, and nothing more. */
  private static readonly MINI_SIDEBAR_PX = 62

  private wirePty(): void {
    window.ember.onData(({ sessionId, data }) => {
      this.allSessions.find((s) => s.id === sessionId)?.write(data)
    })
    window.ember.onExit(({ sessionId, exitCode }) => {
      const session = this.allSessions.find((s) => s.id === sessionId)
      if (!session) return
      session.markExited(exitCode)
      this.syncTabs()
    })
  }

  /** The spare, if there is one and it is the profile being asked for. */
  private takeSpare(profileId?: string): { group: Group; session: Session } | null {
    const wanted = profileId ?? this.config.defaultProfile
    if (!this.spare || this.spare.session.profile.id !== wanted) return null
    const s = this.spare
    this.spare = null
    return s
  }

  /**
   * Build the next spare in genuine quiet.
   *
   * Creating the WebGL context is a 150 to 200ms stop, most of it waiting on the GPU
   * process, and it cannot be sliced. The only thing that can be chosen is *when*: not
   * while anything moves, not within three seconds of a keystroke (a stall under the
   * hands is the one stall that is always noticed), and not while a session is printing.
   * The first version waited for the entrance to settle and then stalled the typing that
   * followed it, which was the hitch this exists to remove, moved one second later.
   */
  private scheduleSpare(): void {
    const QUIET_MS = 3000
    const build = () => {
      if (this.spare || document.hidden) return
      const now = performance.now()
      const busy =
        this.paneUnsub !== null ||
        now - this.lastInputAt < QUIET_MS ||
        this.allSessions.some((s) => now - s.lastOutputAt < 1000)
      if (busy) {
        window.setTimeout(build, 1000)
        return
      }
      try {
        // A real tab, in the stack, not in `groups`: the stylesheet leaves an unmanaged
        // group at opacity 0 with pointer events off, so it is laid out and composited but
        // invisible. The terminal inside it is fitted to the real stage.
        const group = new Group((g) => {
          this.syncTabs()
          g.focused?.focus()
        })
        this.tuneGroup(group)
        // Not opacity 0: Chromium culls a fully transparent layer, so the terminal's GPU
        // surface would only be allocated and first presented the moment the tab became
        // visible — a 130 to 330ms frame, measured, with nothing of ours in it. At 1% it
        // is composited every frame like any other layer (a blend nobody can see, under
        // the live tab) and is already resident when the tab is adopted.
        group.el.style.opacity = '0.01'
        group.el.style.zIndex = '0'
        this.stack.appendChild(group.el)
        const session = this.makeSession()
        group.add(session)
        session.prepare()
        this.spare = { group, session }
      } catch (err) {
        console.warn('[ember] could not prepare a spare tab', err)
      }
    }
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(build, { timeout: 4000 })
      else build()
    }, QUIET_MS)
  }

  /** Throw the spare away — after a config change, it would be built with the old one. */
  private dropSpare(): void {
    this.spare?.group.dispose()
    this.spare = null
    this.scheduleSpare()
  }

  private makeSession(profileId?: string): Session {
    const profile =
      this.config.profiles.find((p) => p.id === (profileId ?? this.config.defaultProfile)) ?? this.config.profiles[0]
    if (!profile) throw new Error('No shell profiles configured')
    return new Session(this.config, profile, {
      onTitle: () => this.syncTabs(),
      onExit: () => this.syncTabs(),
      onInput: (session, data) => {
        if (!this.broadcasting) return false
        const group = this.groups.find((g) => g.panes.includes(session))
        if (!group || !group.isSplit) return false
        for (const p of group.panes) window.ember.write(p.id, data)
        return true
      },
    })
  }

  /** Wall-clock of each step of the last newGroup, for scripts/probe-entrance.mjs. */
  private lastEntrance: Record<string, number> = {}

  async newGroup(profileId?: string, cwd?: string): Promise<Group> {
    const marks: Record<string, number> = {}
    let last = performance.now()
    const lap = (k: string) => {
      const now = performance.now()
      marks[k] = Math.round((now - last) * 10) / 10
      last = now
    }
    const warm = this.takeSpare(profileId)
    const group =
      warm?.group ??
      new Group((g) => {
        this.syncTabs()
        g.focused?.focus()
      })
    if (!warm) {
      this.tuneGroup(group)
      this.stack.appendChild(group.el)
    }
    lap('group')
    group.pop.set(0)
    group.pop.to(1)
    group.slide.set(0)
    this.groups.push(group)

    const session = warm?.session ?? this.makeSession(profileId)
    if (cwd) session.initialCwd = cwd
    session.tabId = group.id
    if (!warm) group.add(session)
    lap('session')
    sound.play('open')
    lap('sound')
    this.applyPaneStyles()
    lap('paneStyles')

    await session.start()
    lap('start(spawn)')
    this.scheduleSpare()
    await this.activate(group.id, true)
    lap('activate')
    this.startPaneMotion()
    this.syncTabs()
    lap('syncTabs')
    marks['warm'] = warm ? 1 : 0
    this.lastEntrance = marks
    return group
  }


  /**
   * A tab that holds writing instead of a shell.
   *
   * Deliberately not a session with a fake pty behind it. No spawn, no bridge env, no
   * activity monitor — a note has no state a terminal card would want to report, and
   * pretending otherwise would mean teaching every one of those to recognise a special
   * case. What it does share is everything about being a tab: the entrance spring, the
   * slide, the sidebar card, Ctrl+W.
   *
   * Opening `notes` twice reuses the tab already showing them rather than stacking
   * identical lists, because the list is a place, not a document.
   */
  /**
   * Show the todo list in a tab: over its terminals if it has any, as the tab itself if
   * not; with no tab at all, a tab of its own. Its own surface, not a note.
   */
  async openTodoIn(group: Group | null): Promise<void> {
    let g = group ?? this.placeGroup('todo')
    if (!g) {
      g = new Group(() => this.syncTabs())
      this.tuneGroup(g)
      g.pop.set(0)
      g.pop.to(1)
      g.slide.set(0)
      this.stack.appendChild(g.el)
      this.groups.push(g)
      g.customTitle = 'Todo'
      sound.play('open')
      this.applyPaneStyles()
      await this.activate(g.id, true)
    } else if (g.id !== this.activeId) {
      await this.activate(g.id)
    }
    const target = g
    const hosted = target.panes.length > 0
    const todo = target.ensureTodo({
      onSources: () => void this.settings.show(this.config, 'Todo'),
      onClaude: (text) => void this.claudeFor(text),
      onOpen: (url) => window.open(url, '_blank'),
      onTitle: (title) => {
        target.customTitle = title
        // The list retitles itself whenever its counts change; the sidebar's badge
        // follows from here rather than waiting on the file watcher.
        void this.countTodo()
        this.syncTabs()
      },
      ...(hosted
        ? {
            onClose: () => {
              target.hideTodo()
              target.focusFirst()
              this.syncTabs()
            },
          }
        : {}),
    })
    await todo.load()
    todo.focus()
    this.startPaneMotion()
    this.syncTabs()
  }

  /**
   * Show the overview in a tab: over its terminals if it has any, as the tab itself if
   * not; with no tab at all, a tab of its own. Same shape as the todo list.
   */
  async openOverviewIn(group: Group | null): Promise<void> {
    let g = group ?? this.placeGroup('overview')
    if (!g) {
      g = new Group(() => this.syncTabs())
      this.tuneGroup(g)
      g.pop.set(0)
      g.pop.to(1)
      g.slide.set(0)
      this.stack.appendChild(g.el)
      this.groups.push(g)
      g.customTitle = 'Overview'
      sound.play('open')
      this.applyPaneStyles()
      await this.activate(g.id, true)
    } else if (g.id !== this.activeId) {
      await this.activate(g.id)
    }
    const target = g
    const hosted = target.panes.length > 0
    const view = target.ensureOverview({
      onActivate: (tabId) => void this.activate(tabId),
      onSend: (tabId, text) => {
        const to = this.groups.find((x) => x.id === tabId)
        if (to) this.sendToSession(to, text, true)
      },
      onKeys: (tabId, data) => {
        const s = this.groups.find((x) => x.id === tabId)?.focused
        if (!s) return
        window.ember.write(s.id, data)
        sound.play('toggle')
      },
      onOpenTodo: () => void this.goPlace('todo'),
      onOpenNotes: (id) => void (id ? this.openNoteInPlace(id) : this.goPlace('notes')),
      onNewNote: () => void this.newNoteInPlace(),
      onTodoChanged: () => void this.countTodo(),
      onTitle: (title) => {
        target.customTitle = title
        this.syncTabs()
      },
      onOrchestrate: (text) => void this.sendToOrchestrator(text),
      ...(hosted
        ? {
            onClose: () => {
              target.hideOverview()
              target.focusFirst()
              this.syncTabs()
            },
          }
        : { onClose: () => this.leavePlace() }),
    })
    view.render(this.overviewRows(performance.now()), this.orchBrief(), this.planFor())
    view.focus()
    this.startPaneMotion()
    this.syncTabs()
  }

  /**
   * The orchestrator as the overview shows it: only its last reply, and whether it is
   * busy. Same conversation as the sidebar's card — `turns` is the one history — but
   * the page is a glance, not a log, so it shows the latest exchange and nothing older.
   */
  private orchBrief(): OverviewOrch {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i]!
      if (t.who === 'agent' && t.text) return { said: t.text, did: t.did ?? [], busy: this.orchBusy }
      if (t.who === 'system') return { said: t.text, did: [], busy: this.orchBusy }
    }
    return { said: '', did: [], busy: this.orchBusy }
  }

  /** The plan's windows, when the user asked to see them. */
  private planFor(): ClaudeUsage | null {
    return this.config.claude.usageLimits ? this.plan : null
  }

  /**
   * The tab that is a place: the overview, the list, the notes or the map as a tab of
   * its own, with no shell under it. There is at most one of each — the sidebar's
   * buttons go to it rather than making another.
   */
  private placeGroup(place: Place): Group | null {
    return (
      this.groups.find(
        (g) =>
          g.panes.length === 0 &&
          (place === 'overview' ? g.isOverview : place === 'todo' ? g.isTodo : place === 'notes' ? g.isNote : g.isMap)
      ) ?? null
    )
  }

  /** Which place is on stage, if the active tab is one. */
  private activePlace(): Place | null {
    const g = this.activeGroup
    if (!g || g.panes.length > 0) return null
    return g.isOverview ? 'overview' : g.isTodo ? 'todo' : g.isNote ? 'notes' : g.isMap ? 'map' : null
  }

  /**
   * Go to a place. With `toggle` — the keyboard shortcut — pressing it again while there
   * goes back to the session you came from, so the overview is one key away and so is
   * the work.
   */
  async goPlace(place: Place, toggle = false): Promise<void> {
    if (toggle && this.activePlace() === place) return this.leavePlace()
    const g = this.placeGroup(place)
    if (place === 'overview') return this.openOverviewIn(g)
    if (place === 'todo') return this.openTodoIn(g)
    if (place === 'map') {
      await this.openMapIn(g)
      return
    }
    if (g) {
      await this.activate(g.id)
      g.note?.focus()
      return
    }
    await this.newNoteGroup()
  }

  /** Back from a place to the session you were last in. */
  private leavePlace(): void {
    const back =
      this.groups.find((g) => g.id === this.lastSessionId && g.panes.length > 0) ?? this.groups.find((g) => g.panes.length > 0)
    if (back) void this.activate(back.id)
  }

  /** Open one note in the notes place. */
  private async openNoteInPlace(id: string): Promise<void> {
    const g = this.placeGroup('notes')
    if (!g) return void (await this.newNoteGroup(id))
    await this.activate(g.id)
    await g.note?.open(id)
    g.note?.focus()
  }

  private async newNoteInPlace(): Promise<void> {
    const g = this.placeGroup('notes') ?? (await this.newNoteGroup())
    if (g.id !== this.activeId) await this.activate(g.id)
    await g.note?.create('')
    g.note?.focus()
  }

  /** Ctrl+Shift+S: the overview, or back to the session if it is up. */
  private toggleOverview(): void {
    const g = this.activeGroup
    if (g?.isOverview && g.panes.length > 0) {
      g.hideOverview()
      g.focusFirst()
      this.syncTabs()
      return
    }
    void this.goPlace('overview', true)
  }

  /**
   * The picker a session is waiting on, read off its screen: the options and a few
   * lines above them for the question. Box-drawing is stripped — the card has its own
   * frame — and the block is dedented so it reads as text, not as a screenshot.
   */
  private static readScreen(text: string): { screen: string[]; choices: OverviewChoice[] } | null {
    const lines = text
      .split('\n')
      .map((l) => l.replace(/[│┃╭╮╰╯]/g, ' ').replace(/\s+$/, ''))
      .filter((l) => l.trim() && !/^[\s─━═┄┈╌-]+$/.test(l))
      .slice(-16)
    const choiceRe = /^\s*([❯›▸>*])?\s*([1-9])[.)]\s+(.+)$/
    // The last run of options on screen is the live one; a numbered list higher up is
    // only output.
    let last = -1
    for (let i = lines.length - 1; i >= 0 && last === -1; i--) if (choiceRe.test(lines[i]!)) last = i
    if (last === -1) return null
    let first = last
    while (first > 0 && choiceRe.test(lines[first - 1]!)) first--
    // A picker's own footer ("Esc to cancel · Enter to confirm") belongs to it; whatever
    // is under that is the rest of the screen, not the question.
    if (lines[last + 1] && /\b(esc|enter|confirm|cancel|tab)\b/i.test(lines[last + 1]!)) last++
    const block = lines.slice(Math.max(0, first - 6), last + 1)
    const indent = Math.min(...block.map((l) => l.match(/^\s*/)![0].length))
    const screen = block.map((l) => l.slice(indent))
    const choices: OverviewChoice[] = []
    for (const l of block) {
      const m = l.match(choiceRe)
      if (!m) continue
      const label = m[3]!.trim()
      choices.push({ key: m[2]!, label: label.length > 46 ? `${label.slice(0, 45)}…` : label, selected: !!m[1] && m[1] !== '*' })
    }
    return { screen, choices }
  }

  /**
   * Every shell tab, as the overview shows it. A tab that is showing the overview
   * is the one you are looking from, not one to look at — even when a shell
   * sits underneath it — so it is left out.
   *
   * A todo or notes tab is in here too, shell or no shell. It is one of the things you
   * have open, and leaving the pane-less ones out meant the list you keep all day was
   * the one thing the overview could not see.
   */
  private overviewRows(now: number): OverviewRow[] {
    const t = this.config.theme
    const hues = [t.cyan, t.magenta, t.green, t.yellow, t.blue, t.red]
    return this.groups
      .filter((g) => g.panes.length > 0 && !g.isOverview)
      .map((g, i) => {
        const focused = g.focused
        const cwd = focused?.cwd || focused?.initialCwd || ''
        const activity = g.aggregate(now)
        const picker =
          activity.state === 'attention' && activity.attention === 'question' && focused ? App.readScreen(focused.visibleText()) : null
        return {
          tabId: g.id,
          // A tab showing a surface over its shell is titled for the surface; the row is
          // about the shell underneath.
          title: g.isTodo || g.isNote || g.isMap ? (focused?.title ?? g.displayTitle) : g.displayTitle,
          cwd,
          git: this.gitByCwd.get(cwd) ?? null,
          url: focused?.urls[focused.urls.length - 1] ?? null,
          activity,
          claude: this.config.claude.statusLine ? (this.claudeByTab.get(g.id) ?? null) : null,
          brief: this.briefByTab.get(g.id) ?? null,
          unread: g.id === this.activeId ? 0 : g.panes.reduce((n, p) => n + p.unread, 0),
          isActive: g.id === this.activeId,
          panes: g.panes.length,
          hue: hues[i % hues.length]!,
          screen: picker?.screen ?? null,
          choices: picker?.choices ?? [],
        }
      })
  }

  private async countTodo(): Promise<void> {
    try {
      const text = await window.ember.todo.read()
      this.todoOpen = text.split('\n').filter((l) => /^\s*- \[ \] \S/.test(l)).length
      this.syncTabs()
    } catch {
      /* the count is a convenience */
    }
  }

  /** Ctrl+Shift+D: the list over the tab you are in, or the shell back if it is up. */
  private toggleTodo(): void {
    const g = this.activeGroup
    if (g?.isTodo && g.panes.length > 0) {
      g.hideTodo()
      g.focusFirst()
      this.syncTabs()
      return
    }
    void this.goPlace('todo', true)
  }

  /**
   * The architecture map, in a tab: over its terminals if it has any, as the tab itself
   * if not; with no tab at all, a tab of its own. `project` opens one map directly.
   */
  async openMapIn(group: Group | null, project?: string): Promise<string> {
    let g = group
    if (!g) {
      g = this.groups.find((x) => x.isMap && x.panes.length === 0) ?? null
      if (g && g.id !== this.activeId) await this.activate(g.id)
    }
    if (!g) {
      g = new Group(() => this.syncTabs())
      this.tuneGroup(g)
      g.pop.set(0)
      g.pop.to(1)
      g.slide.set(0)
      this.stack.appendChild(g.el)
      this.groups.push(g)
      g.customTitle = 'Map'
      sound.play('open')
      this.applyPaneStyles()
      await this.activate(g.id, true)
    } else if (g.id !== this.activeId) {
      await this.activate(g.id)
    }
    const target = g
    const hosted = target.panes.length > 0
    const fresh = !target.map
    const view = target.ensureMap({
      onTitle: (title) => {
        target.customTitle = title
        this.syncTabs()
      },
      onChange: (brief, cwd, title) => {
        void this.startCrewSession(brief, cwd, title)
        this.flashToast(`${(AGENTS[this.config.agent.default] ?? AGENTS.claude).name} is starting on: ${title}`)
      },
      onShell: (cwd) => void this.newGroup(undefined, cwd),
      onOpenUrl: (url) => window.open(url, '_blank'),
      onRevealPath: (path) => window.ember.map.reveal(path),
      onFocusTab: (tabId) => {
        if (this.groups.some((x) => x.id === tabId)) void this.activate(tabId)
      },
      tabTitle: (tabId) => this.groups.find((x) => x.id === tabId)?.displayTitle,
      ...(hosted
        ? {
            onClose: () => {
              target.hideMap()
              target.focusFirst()
              this.syncTabs()
            },
          }
        : {}),
    })
    let result = 'Map'
    if (project) result = await view.openNamed(project)
    else if (fresh) await view.showList()
    view.focus()
    this.startPaneMotion()
    this.syncTabs()
    return result
  }

  /** Ctrl+Shift+G: the map over the tab you are in, or the shell back if it is up. */
  private toggleMap(): void {
    const g = this.activeGroup
    if (g?.isMap && g.panes.length > 0) {
      g.hideMap()
      g.focusFirst()
      this.syncTabs()
      return
    }
    void this.goPlace('map', true)
  }

  /**
   * Show the notes in a tab: over its terminals if it has any, as the tab itself if not.
   * With no tab at all, a notes tab is made.
   */
  async openNotesIn(group: Group | null, mode: 'list' | 'new' | 'open', text?: string, id?: string): Promise<void> {
    if (!group) {
      const g = await this.newNoteGroup(mode === 'open' ? id : undefined)
      if (mode === 'new') await g.note?.create(text ?? '')
      g.note?.focus()
      return
    }
    if (group.id !== this.activeId) await this.activate(group.id)
    const hosted = group.panes.length > 0
    const note = group.ensureNote({
      onTitle: (title) => {
        group.customTitle = title
        this.syncTabs()
      },
      ...(hosted
        ? {
            onClose: () => {
              group.hideNote()
              group.focusFirst()
              this.syncTabs()
            },
          }
        : {}),
    })
    if (mode === 'open' && id) await note.open(id)
    else if (mode === 'new') await note.create(text ?? '')
    else await note.showList()
    note.focus()
    this.syncTabs()
  }

  async newNoteGroup(noteId?: string): Promise<Group> {
    if (!noteId) {
      const existing = this.groups.find((g) => g.isNote)
      if (existing) {
        await this.activate(existing.id)
        await existing.note?.showList()
        existing.note?.focus()
        return existing
      }
    }

    const group = new Group(() => this.syncTabs())
    this.tuneGroup(group)
    group.pop.set(0)
    group.pop.to(1)
    group.slide.set(0)
    this.stack.appendChild(group.el)
    this.groups.push(group)

    const note = group.ensureNote({
      onTitle: (title) => {
        group.customTitle = title
        this.syncTabs()
      },
    })
    group.customTitle = 'Notes'

    sound.play('open')
    this.applyPaneStyles()
    await this.activate(group.id, true)

    if (noteId) await note.open(noteId)
    else await note.showList()
    note.focus()

    this.startPaneMotion()
    this.syncTabs()
    return group
  }

  /** Add a sibling terminal beside the focused one, sharing the stage. */
  async splitActive(direction: 'row' | 'column' = 'row', profileId?: string): Promise<void> {
    const group = this.activeGroup
    if (!group) return
    const session = this.makeSession(profileId)
    // A new pane inherits where you already are, which is almost always what you want.
    session.initialCwd = group.focused?.cwd ?? ''
    session.tabId = group.id
    sound.play('split')

    group.add(session, direction)
    await session.start()
    group.refit()
    group.focusFirst()
    session.focus()
    this.syncTabs()
  }

  private indexOf(id: string): number {
    return this.groups.findIndex((g) => g.id === id)
  }

  async activate(id: string, immediate = false): Promise<void> {
    if (this.activeId === id) return
    const next = this.groups.find((g) => g.id === id)
    if (!next) return

    const prev = this.activeGroup
    const dir = prev ? (this.indexOf(id) > this.indexOf(prev.id) ? 1 : -1) : 0
    if (prev && prev.panes.length > 0) this.lastSessionId = prev.id

    this.activeId = id

    if (prev && !immediate) {
      prev.slide.to(-dir * 60)
      next.slide.set(dir * 85)
      next.slide.to(0)
    } else {
      for (const g of this.groups) if (g.id !== id) g.slide.set(g.slide.value || -60)
      next.slide.set(0)
    }

    sound.play('switch')


    next.acknowledge()
    next.panes.forEach((p) => p.markRead())
    this.notifiedGroups.delete(id)

    // Paint the new styles *before* focusing. The outgoing group is still carrying
    // `visibility: hidden` from the previous frame, and a hidden element silently
    // refuses focus — which is why typing after a switch sometimes went nowhere.
    this.applyPaneStyles()
    next.refit()
    // Nothing has drawn into this pane's canvas since it went off-screen. Force a
    // complete draw before it slides in, so the ghost frame never reaches the eye.
    // See Session.repaint.
    next.repaint()
    next.focusFirst()
    // Clicking a card moves focus to the sidebar; re-assert on the next frame so the
    // caret ends up in the terminal regardless of how the switch was triggered.
    requestAnimationFrame(() => {
      if (this.activeId === id) next.focusFirst()
    })

    this.startPaneMotion()
    this.syncTabs()
    // Whatever the motion loop is doing, the tab you asked for is on stage within a
    // second: a fixed check after the entrance would have finished on its own.
    window.setTimeout(() => {
      if (this.activeId === id) this.ensureOnStage(true)
    }, 900)
  }

  closeFocusedPane(): void {
    const group = this.activeGroup
    if (!group) return
    if (!group.isSplit) {
      this.closeGroup(group.id)
      return
    }
    const focused = group.focused
    if (!focused) return
    const removed = group.remove(focused.id)
    removed?.dispose()
    group.refit()
    group.focusFirst()
    this.syncTabs()
  }

  closeGroup(id: string): void {
    const idx = this.indexOf(id)
    if (idx === -1) return
    const group = this.groups[idx]!
    sound.play('close')
    this.groups.splice(idx, 1)
    group.dispose()
    window.ember.panel.forget(id)
    window.ember.crew.forget(id)
    this.claudeByTab.delete(id)
    this.crewTasks.delete(id)
    // A closed tab must not keep the microphone or go on being read aloud.

    if (this.groups.length === 0) {
      // Nothing left to show: the window stays, with the empty state and the sidebar's
      // header. The cards, the title and the focus ring all fall back to their empty forms
      // through syncTabs.
      this.activeId = null
      this.syncTabs()
      return
    }
    if (this.activeId === id) {
      const nextIdx = Math.min(idx, this.groups.length - 1)
      this.activeId = null
      void this.activate(this.groups[nextIdx]!.id, true)
    }
    this.syncTabs()
  }

  /**
   * The tab you selected is the tab you see.
   *
   * Every switch is a spring driven by the frame loop, and the styles that put a tab on
   * stage are written by that loop. A note or todo tab was seen arriving blank and
   * staying blank until the next switch: nothing in the code should leave a spring
   * mid-flight, but something did. So, on the activity tick, while no motion is running,
   * the active tab is checked and snapped into place if it is anywhere else. Logged, so
   * the cause can be caught in the act rather than guessed at.
   */
  private ensureOnStage(force = false): void {
    const now = performance.now()
    // A loop that is registered but has not run a frame in a second is not running
    // (frames stop while the window is hidden, and sometimes do not come back on the
    // first frame after); one that has run for six seconds has a spring that will
    // never settle. Either way the tab must land, so the loop's claim is overridden.
    const stalled = !!this.paneUnsub && now - this.lastMotionAt > 1000
    const endless = !!this.paneUnsub && now - this.motionStartedAt > 3000
    if (this.paneUnsub && !stalled && !endless && !force) return
    const g = this.activeGroup
    if (!g) return
    const wrongTarget = g.slide.target !== 0 || g.pop.target !== 1
    const off = Math.abs(g.slide.value) > 0.5 || g.pop.value < 0.99 || !g.slide.settled || !g.pop.settled
    const hidden = g.el.style.visibility === 'hidden' || Number(g.el.style.opacity || '1') < 0.99 || g.panesEl.style.display === 'none'
    if (!off && !hidden && !wrongTarget && !endless) {
      if (!this.paneUnsub) this.ensureGeometry(g)
      return
    }
    const entry = {
      id: g.id,
      reason: stalled ? 'loop stalled' : endless ? 'loop endless' : wrongTarget ? 'wrong target' : off ? 'off' : 'hidden',
      forced: force,
      loop: !!this.paneUnsub,
      sinceFrame: Math.round(now - this.lastMotionAt),
      slide: g.slide.value,
      slideTarget: g.slide.target,
      pop: g.pop.value,
      opacity: g.el.style.opacity,
      visibility: g.el.style.visibility,
      panes: g.panesEl.style.display,
    }
    console.warn('[ember] active tab was off stage; snapping it back', entry)
    window.ember.diag.log({ kind: 'offstage', ...entry })
    // Every tab lands where it was going; the loop then sees nothing moving and ends.
    for (const other of this.groups) {
      other.slide.set(other.id === g.id ? 0 : other.slide.target || -60)
      other.pop.set(other.id === g.id ? 1 : other.pop.target)
    }
    this.applyPaneStyles()
    if (stalled || endless) {
      this.paneUnsub?.()
      this.paneUnsub = null
      Session.frozen = false
    }
    g.refit()
  }

  /**
   * The springs say the tab is on stage; is it? A tab seen 60% up with its springs at
   * rest and its styles right was moved by something else: a scrolled ancestor, a
   * layout that came out short, a transform from elsewhere. Measured, not inferred:
   * the tab's box against the stage's. When they disagree, everything that could have
   * moved it is reset, and what was found goes to the log so the cause can be read.
   */
  private lastGeometryFixAt = 0
  private ensureGeometry(g: Group): void {
    const sb = this.stack.getBoundingClientRect()
    const gb = g.el.getBoundingClientRect()
    if (sb.height < 50) return
    const dy = gb.top - sb.top
    const dx = gb.left - sb.left
    const dh = gb.height - sb.height
    if (Math.abs(dy) < 2 && Math.abs(dx) < 2 && Math.abs(dh) < 2) return
    const now = performance.now()
    if (now - this.lastGeometryFixAt < 2000) return
    this.lastGeometryFixAt = now
    const scrolled = [this.stack, g.el, g.panesEl, ...g.panesEl.children]
      .filter((e): e is HTMLElement => e instanceof HTMLElement && (e.scrollTop !== 0 || e.scrollLeft !== 0))
      .map((e) => `${e.className}:${e.scrollTop}/${e.scrollLeft}`)
    const entry = {
      id: g.id,
      surface: g.isTodo ? 'todo' : g.isOverview ? 'overview' : g.isNote ? 'note' : 'shell',
      dy: Math.round(dy),
      dx: Math.round(dx),
      dh: Math.round(dh),
      stack: [Math.round(sb.left), Math.round(sb.top), Math.round(sb.width), Math.round(sb.height)],
      group: [Math.round(gb.left), Math.round(gb.top), Math.round(gb.width), Math.round(gb.height)],
      win: [window.innerWidth, window.innerHeight],
      transform: getComputedStyle(g.el).transform,
      inlineTransform: g.el.style.transform,
      opacity: g.el.style.opacity,
      scrolled,
      slide: g.slide.value,
      pop: g.pop.value,
      loop: !!this.paneUnsub,
      frozen: Session.frozen,
      hasFocus: document.hasFocus(),
      hidden: document.hidden,
      panel: g.panel ? { open: g.panel.isOpen, flex: g.panel.el.style.flex, transform: g.panel.el.style.transform } : null,
    }
    console.warn('[ember] active tab is not where the stage is; resetting', entry)
    window.ember.diag.log({ kind: 'geometry', ...entry })
    for (const e of [this.stack, g.el, g.panesEl, ...g.panesEl.children]) {
      if (e instanceof HTMLElement) {
        e.scrollTop = 0
        e.scrollLeft = 0
      }
    }
    g.slide.set(0)
    g.pop.set(1)
    this.applyPaneStyles()
    g.refit()
  }

  /** The empty state, shown when the last tab goes; its button takes focus so Enter opens one. */
  private showEmpty(on: boolean): void {
    if (this.emptyEl.hidden === !on) return
    this.emptyEl.hidden = !on
    if (on) this.emptyEl.querySelector<HTMLButtonElement>('.ember-empty-new')?.focus()
  }

  /** Apply a new card order to the underlying group list. */
  private reorderGroups(ids: string[]): void {
    const next = ids.map((id) => this.groups.find((g) => g.id === id)).filter((g): g is Group => !!g)
    if (next.length !== this.groups.length) return
    this.groups.length = 0
    this.groups.push(...next)
  }

  /** Push the configured slide feel onto a group's springs. */
  private tuneGroup(group: Group): void {
    const { slideStiffness, slideDamping } = this.config.motion
    group.slide.stiffness = slideStiffness
    group.slide.damping = slideDamping
    // A voice tab is already a conversation with its own canvas; a second panel beside
    // it would be two answers to the same question.
    this.deferPanel(group)
  }

  /**
   * Give a tab its panel later, not now.
   *
   * The panel is a <webview>, and attaching one spawns a guest process — 150 to 280ms
   * that used to land in the first frame of the tab's entrance, which is why that one
   * animation stayed janky after everything else was smooth. A push or the panel switch
   * creates it on demand anyway; this only makes sure it exists before the person reaches
   * for it, at a moment when nothing is moving.
   */
  private deferPanel(group: Group): void {
    const build = () => {
      if (group.panel || !this.groups.includes(group)) return
      if (this.paneUnsub) {
        window.setTimeout(build, 500)
        return
      }
      group.ensurePanel(this.panelHooks(group))
    }
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(build, { timeout: 3000 })
      else build()
    }, 1200)
  }

  /**
   * What a tab's panel is allowed to do to the tab.
   *
   * Relaying out is the old half. The new half is that a press on the panel types into
   * the shell beside it — which is what makes it a place to work from rather than a
   * picture to look at. It goes to the focused pane of the tab that owns the panel, so
   * a panel can never type into a session you are not looking at through it.
   */
  private panelHooks(group: Group): PanelHooks {
    return {
      onLayout: () => this.startPaneMotion(),
      onSend: (text, submit) => this.sendToSession(group, text, submit),
      onResize: (fraction, done) => this.resizePanels(fraction, done),
    }
  }

  /**
   * The panel's edge was dragged.
   *
   * The width is one setting shared by every tab, so every open panel follows the drag,
   * not only the one whose edge was taken. While the pointer is down the change is
   * local — `applyPanel` at rest simply follows the new share — and the terminals are
   * refitted only on release, since every intermediate refit is a pty resize per pane.
   * Release also writes the setting, through the same door the Settings slider uses,
   * so the config-change round trip is what makes it stick.
   */
  private resizePanels(fraction: number, done: boolean): void {
    const width = Math.round(fraction * 1000) / 1000
    this.config = { ...this.config, panel: { ...this.config.panel, width } }
    for (const g of this.groups) g.applyPanel(width)
    if (!done) return
    for (const g of this.groups) g.refit()
    this.settings.sync(this.config)
    window.ember.saveConfig(this.config)
  }

  /**
   * Type a line into a tab's shell, optionally pressing Enter.
   *
   * Newlines are collapsed rather than passed through: the Claude prompt is a line
   * editor that treats Enter as send, so a two-line message would arrive as one line
   * and one orphaned fragment.
   */
  private sendToSession(group: Group, text: string, submit: boolean): void {
    const session = group.focused
    const line = text.replace(/\s*\r?\n\s*/g, ' ').trim()
    if (!session || !line) return

    if (!submit) {
      window.ember.write(session.id, `${line} `)
      session.focus()
      sound.play('toggle')
      return
    }

    // The Enter goes in a separate write, a beat later. `${line}\r` in one go works
    // against PowerShell — which is all the panel probe covered — but not against Claude
    // Code, whose TUI reads a burst ending in CR as a *paste* and turns the carriage
    // return into a newline in the composer. The button then looks like it did nothing
    // while the text sits in the prompt, and the panel's whole point is that pressing
    // something makes it happen.
    window.ember.write(session.id, line)
    window.setTimeout(() => window.ember.write(session.id, '\r'), App.SUBMIT_GAP_MS)
    sound.play('toggle')
  }

  /** Gap between typing a line and pressing Enter, so a TUI stops reading it as a paste. */
  private static readonly SUBMIT_GAP_MS = 140

  /**
   * Route pushes from the bridge to the tab that asked for them.
   *
   * A push can arrive for a tab that is not on screen — that is the useful case, not an
   * edge case, since the whole point of a background session is that it works while you
   * are elsewhere. It opens its own panel regardless and is simply there when you switch
   * back.
   */
  private wirePanel(): void {
    // A session's status line reporting in. Kept by tab, dropped with the tab; the card
    // reads it on its next refresh.
    window.ember.claude.onStatus((status) => {
      if (!this.groups.some((g) => g.id === status.tabId)) return
      this.claudeByTab.set(status.tabId, status)
    })

    void this.countTodo()
    window.ember.usage.onState((u) => (this.plan = u))
    void window.ember.usage.state().then((u) => (this.plan = u))

    // The transcript's view of each session, for the overview. Main keeps them from the
    // moment a session announces itself; this mirror is what the rows are built from.
    window.ember.overview.onBrief((brief) => this.briefByTab.set(brief.tabId, brief))
    void window.ember.overview.all().then((all) => {
      for (const b of all) this.briefByTab.set(b.tabId, b)
    })

    window.ember.panel.onPush((push) => {
      const group = this.groups.find((g) => g.id === push.tabId)
      if (!group) return
      const panel = group.panel ?? group.ensurePanel(this.panelHooks(group))
      panel.push(push, this.config.panel.autoOpen)
      this.startPaneMotion()
      if (group.id !== this.activeId) sound.play('open')
      // And onto the phone, if one is watching this tab. The whole reason the panel is
      // pushed without being asked for is that he should not have to think to look at it;
      // that argument does not stop applying when he is holding the phone instead.
      if (push.tabId === this.activeId) void this.remote.panel(push)
    })

    window.ember.panel.onClear(({ tabId }) => {
      this.groups.find((g) => g.id === tabId)?.panel?.clear()
      this.startPaneMotion()
      if (tabId === this.activeId) void this.remote.clearPanel()
    })

    // The way back in. A panel document cannot reach this process directly — it is on
    // the bridge's origin inside a webview, which is the point — so what the user did
    // to it comes round through main and lands here.
    window.ember.panel.onAct((act) => {
      const group = this.groups.find((g) => g.id === act.tabId)
      if (!group) return
      this.sendToSession(group, act.text ?? '', act.submit !== false)
    })
  }

  /**
   * Dictation and narration, per tab.
   *
   * Both are switches over an existing session rather than a different kind of session:
   * flipping either one changes nothing about the shell, the CLI, or the conversation,
   * so you can go hands-free mid-task and come back to the keyboard without anything
   * having moved. That was the point — not a voice mode you enter and leave.
   */
  private wireVoice(): void {
    // The phone link comes up at boot and stays up. It is not started on demand because
    // the demand arrives from the other side: the point is that the user can reach a laptop
    // that has been sitting untouched for hours.
    void window.ember.remote.account().then((account) => this.remote.start(account))

    // `note`/`notes`, typed in any shell, arriving via the bridge. A shell cannot open a
    // tab; it says what it wants and this decides what that means.
    // Coming back from hidden (frames stop while the window is): everything lands.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.ensureOnStage(true)
    })
    window.ember.cmd.onRun((e) => {
      void this.runCli(e.words, e.tabId).then(
        (result) => window.ember.cmd.reply(e.reqId, { result }),
        (err: unknown) => window.ember.cmd.reply(e.reqId, { result: '', error: err instanceof Error ? err.message : String(err) }),
      )
    })
    window.ember.notes.onOpen(async ({ mode, text, id, tabId }) => {
      // In the tab that asked, over its shell — the way `claude` runs where it was typed.
      // A request with no tab (the palette) lands on the tab you are looking at.
      const group = this.groups.find((g) => g.id === tabId) ?? this.activeGroup
      if (mode === 'todo') await this.openTodoIn(group)
      else await this.openNotesIn(group, mode ?? 'list', text, id)
    })
    window.ember.notes.onChanged((e) => {
      if (e.id.toLowerCase() === 'todo.md') void this.countTodo()
      for (const g of this.groups) {
        void g.note?.external(e)
        if (e.id.toLowerCase() === 'todo.md') void g.todo?.external()
      }
    })



    // A session the voice handed work to has gone quiet. This is the whole difference
    // between dispatching work and forgetting about it.
    this.wireOrchestratorTools()
    window.ember.crew.onNote((note) => {
      const group = this.groups.find((g) => g.id === note.tabId)
      const title = group?.displayTitle ?? note.tabId
      this.crewNotes++
      const said = `Session "${title}" (${note.tabId}) has finished. It said: ${note.text}`
      this.notice(said)
      // The other half of handing work out while driving. The phone decides whether to
      // say it aloud — that needs to know if anyone is mid-sentence, which only it sees.
      void this.remote.note(said)
      this.flashToast(`"${title}" finished`)
    })
  }





  // ---------------------------------------------------------------- the orchestrator

  /**
   * One agent, two ways in.
   *
   * `history` is the whole point of this section. Both channels append to it and both
   * read from it, so a thread started out loud continues in text without re-explaining
   * anything — which is the thing that was actually asked for, not "a chat box as well".
   * A call is a front end; the conversation outlives it.
   */
  private readonly history: TurnMessage[] = []
  /** The same conversation as `history`, shaped for reading rather than for the model. */
  private readonly turns: Turn[] = []
  private orchBusy = false

  /**
   * How much of the window the orchestrator takes when open.
   *
   * A share rather than a fixed width, floored so it stays readable and capped so it
   * cannot dominate. At 46% it was taking 460px of an 1180px window and leaving the
   * visualisation panel 200 — technically not overlapping, which was the bug being
   * fixed, and still unusable, which was not the point.
   */
  /** What the left column should be, given everything that can claim it. */
  private columnWidth(): number {
    if (document.body.classList.contains('is-zen')) return 0
    if (this.orchestrator.isOpen) return App.ORCH_COLUMN_PX
    return document.body.classList.contains('sidebar-mini') ? App.MINI_SIDEBAR_PX : this.config.window.sidebarWidth
  }

  /**
   * The orchestrator opens under the session list, in the same column.
   *
   * It was a third column to the left of the sessions, which never sat right; then it
   * took the sessions' place, which hid the very things it hands work to. It is the thing
   * that runs the sessions, so it sits beneath them: the list shrinks to its content, the
   * conversation takes the rest of the column with its composer at the bottom, and the
   * column widens a little because a conversation needs more room than a list. The tabs
   * stay in view and clickable the whole time.
   */
  /** The last few turns as plain prose, for the phone as it connects. */
  private recentConversation(): string {
    return this.turns
      .slice(-8)
      .map((t) => `${t.who === 'you' ? 'The user' : t.who === 'agent' ? 'You' : 'Note'}: ${t.text}`)
      .join(' — ')
      .slice(0, 2000)
  }

  /** What was said on the phone, folded into the same thread. */
  private rememberSpoken(line: { who: 'user' | 'voice'; text: string }): void {
    const text = line.text.trim()
    if (!text) return
    this.history.push({ role: line.who === 'user' ? 'user' : 'assistant', content: text })
    this.turns.push({ who: line.who === 'user' ? 'you' : 'agent', text, spoken: true })
    this.trimHistory()
    this.paintOrchestrator()
  }

  /** Something the orchestrator should know happened: shown in its thread. */
  private notice(line: string): void {
    this.turns.push({ who: 'system', text: line })
    this.trimHistory()
    this.paintOrchestrator()
  }

  private toggleOrchestrator(): void {
    this.orchestrator.toggle()
    this.sidebar.el.classList.toggle('has-orch', this.orchestrator.isOpen)
    this.setColumn(this.columnWidth())
    this.syncVoiceChrome()
    if (this.orchestrator.isOpen) this.orchestrator.render(this.turns, this.orchBusy)
    else this.activeGroup?.focused?.focus()
  }

  private paintOrchestrator(): void {
    if (this.orchestrator.isOpen) this.orchestrator.render(this.turns, this.orchBusy)
  }

  /**
   * Run a typed turn to completion, tools and all.
   *
   * The loop lives here rather than in main because the tools are *here* — they open
   * tabs, read session state, dispatch work. Main does the one part only main can do,
   * which is hold the key and make the request.
   */
  private async sendToOrchestrator(text: string): Promise<{ text: string; did: string[] }> {
    if (this.orchBusy) return { text: 'I am still working on the last thing. Give me a moment.', did: [] }
    if (!text.trim()) return { text: '', did: [] }

    // The conversation so far, as prose: the CLI turn is stateless, so this is its memory.
    const recap = this.turns
      .filter((t) => t.who !== 'system' && t.text)
      .slice(-12)
      .map((t) => `${t.who === 'you' ? 'User' : 'You'}: ${t.text}`)
      .join('\n')

    this.history.push({ role: 'user', content: text })
    this.turns.push({ who: 'you', text })
    this.orchBusy = true
    this.orchUsed = []
    this.paintOrchestrator()

    let answer = ''
    const used = this.orchUsed
    try {
      // One turn of the person's own agent CLI with ember-orch attached. Its tool calls
      // arrive through wireOrchestratorTools while this waits; no key is involved.
      const result = await window.ember.orch.cli(text, recap)
      answer = result.ok ? result.text.trim() : `The orchestrator did not answer: ${result.error ?? 'unknown error'}`
      if (result.ok && answer) {
        this.history.push({ role: 'assistant', content: answer })
        this.turns.push({ who: 'agent', text: answer, ...(used.length ? { did: [...used] } : {}) })
      } else {
        this.turns.push({ who: 'system', text: answer || 'No answer came back.' })
      }
    } catch (err) {
      answer = `That went wrong: ${(err as Error).message}`
      this.turns.push({ who: 'system', text: answer })
    }

    this.orchBusy = false
    this.trimHistory()
    this.paintOrchestrator()
    return { text: answer, did: [...used] }
  }

  /** The tools the current orchestrator turn has called, shown as it works. */
  private orchUsed: string[] = []

  /**
   * Answer the orchestrator's tool calls. They come from a headless agent run through
   * resources/mcp-orch.mjs and the bridge; the tabs are here, so they are run here.
   */
  private wireOrchestratorTools(): void {
    window.ember.orch.onTool(({ reqId, name, args }) => {
      this.orchUsed.push(name === 'ask_claude' ? 'ask_session' : name)
      if (this.orchBusy) this.orchestrator.render([...this.turns, { who: 'agent', text: '', did: [...this.orchUsed] }], true)
      void this.runVoiceTool(this.activeId ?? '', name, args)
        .catch((err: Error) => `That failed: ${err.message}`)
        .then((out) => window.ember.orch.toolResult(reqId, out))
    })
  }

  /**
   * Keep the conversation from growing without limit.
   *
   * Trimmed from the front and never in the middle of a tool exchange: an assistant
   * message with `tool_calls` whose `tool` replies have been dropped is rejected by the
   * API, so the cut has to land on a clean user turn.
   */
  private trimHistory(): void {
    const MAX = 60
    while (this.history.length > MAX) {
      const cut = this.history.findIndex((m, i) => i > 0 && m.role === 'user')
      if (cut < 1) break
      this.history.splice(0, cut)
    }
    while (this.turns.length > 80) this.turns.shift()
  }

  /**
   * Fold what was said on a call into the same conversation.
   *
   * Without this the two channels would be two agents wearing one name: you would say
   * something out loud, hang up, start typing, and be met by something with no idea what
   * you had just been discussing.
   */
  /**
   * Everything the voice can do, dispatched by name.
   *
   * Every branch returns a *sentence*, including the failures. The voice is holding the
   * floor waiting for this string, so "there is no session in that tab" has to be
   * something it can say out loud — an exception would leave the call silent with nothing
   * to recover from.
   */
  private async runVoiceTool(tabId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const arg = (k: string): string => String(args[k] ?? '').trim()

    switch (name) {
      case 'ask_claude':
        return this.askClaude(this.resolveTab(arg('session')) ?? tabId, arg('question'))

      case 'list_sessions':
        return this.describeCrew()

      case 'send_work': {
        const target = this.resolveTab(arg('session'))
        if (!target) return `There is no session called "${arg('session')}". Read the list again.`
        return this.sendWork(target, arg('task'))
      }

      case 'start_session':
        return this.startCrewSession(arg('task'), arg('directory'), arg('name'))

      case 'check_work': {
        const target = this.resolveTab(arg('session'))
        if (!target) return `There is no session called "${arg('session')}".`
        return this.checkWork(target)
      }

      case 'list_projects': {
        const projects = await window.ember.listProjects()
        if (!projects.length) return 'No project directories found under his home folder.'
        return projects.map((p) => p.name).join(', ')
      }

      case 'show_session': {
        const target = this.resolveTab(arg('session'))
        if (!target) return `There is no session called "${arg('session')}".`
        void this.activate(target)
        return 'It is on screen now.'
      }

      /**
       * The one tool that destroys something.
       *
       * Two refusals rather than one, and both matter more here than they would at the
       * keyboard, because the thing calling this may be doing so on a spoken instruction
       * from a car and cannot see what it is about to throw away.
       *
       * The last-session guard stays even though closing the last tab no longer quits
       * Ember: an agent on a call should not be the one that clears the desk, and the
       * session it is talking through may be that last one.
       */
      case 'close_session': {
        const target = this.resolveTab(arg('session'))
        if (!target) return `There is no session called "${arg('session')}". Read the list again.`
        const group = this.groups.find((g) => g.id === target)
        if (!group) return 'That session is already gone.'

        if (this.groups.length <= 1) {
          return 'That is the only session open. Open another one first if it really has to go.'
        }

        const title = group.displayTitle
        const busy = group.aggregate(performance.now()).state === 'working'
        if (busy && args['force'] !== true) {
          return `"${title}" is still working. Tell the user what it is doing and ask, then call this again with force if he says to.`
        }

        this.closeGroup(target)
        return busy ? `Closed "${title}", interrupting what it was doing.` : `Closed "${title}".`
      }

      default:
        return `There is no tool called ${name}.`
    }
  }

  /**
   * Turn whatever the voice called a session into a real tab id.
   *
   * It has only ever seen what `describeCrew` said, and speech being what it is, it will
   * say "the ember one" or "two" as readily as an id. Matching on the id, the position
   * and the title covers all three without making the model be precise about something
   * it heard out loud.
   */
  private resolveTab(said: string): string | null {
    if (!said) return null
    const want = said.trim().toLowerCase()
    const byId = this.groups.find((g) => g.id.toLowerCase() === want)
    if (byId) return byId.id

    const n = Number(want.replace(/[^0-9]/g, ''))
    if (Number.isFinite(n) && n >= 1 && n <= this.groups.length) return this.groups[n - 1]!.id

    const byTitle = this.groups.find((g) => g.displayTitle.toLowerCase().includes(want))
    return byTitle?.id ?? null
  }

  /** Every session and what it is doing, as one line each for the voice to read. */
  private describeCrew(): string {
    if (!this.groups.length) return 'There are no sessions open.'
    const now = performance.now()
    const lines = this.groups.map((g, i) => {
      const a = g.aggregate(now)
      const where = g.focused?.cwd?.split(/[/\\]/).pop() ?? ''
      const state = a.state === 'attention' ? 'waiting for the user' : a.state
      const detail = a.detail ? `, ${a.detail}` : ''
      const agent = g.focused?.activity.current.agent
      const claude = agent ? ` (${AGENTS[agent].name})` : ' (a plain shell, no agent running)'
      return `${i + 1}. id ${g.id}, "${g.displayTitle}"${where ? ` in ${where}` : ''} — ${state}${detail}${claude}`
    })
    return lines.join('; ')
  }

  /**
   * The synchronous half: ask, and hold the call until the turn completes.
   *
   * Only for things the user is actually waiting to hear. Work goes through `sendWork`.
   */
  private async askClaude(tabId: string, question: string): Promise<string> {
    const group = this.groups.find((g) => g.id === tabId)
    const session = group?.focused
    if (!session) return 'That terminal tab is gone. Tell the user the session closed.'
    const agent = session.activity.current.agent
    if (agent && agent !== 'claude') {
      this.typeTask(session.id, question)
      return this.watchTurn(tabId, 5 * 60_000)
    }

    const result = await window.ember.voice.ask(tabId, session.id, question)
    if (!result.ok) return result.error ?? 'Claude could not answer that.'
    if (result.partial) {
      return `${result.text ?? ''} — that is as far as it got; it is still working.`
    }
    return result.text ?? ''
  }

  /** The asynchronous half: hand it over and get straight back to the conversation. */
  private async sendWork(tabId: string, task: string): Promise<string> {
    const group = this.groups.find((g) => g.id === tabId)
    const session = group?.focused
    if (!session) return 'That terminal tab is gone.'
    if (!task) return 'There was no task in that — say what it should do.'

    const agent = session.activity.current.agent
    if (agent && agent !== 'claude') {
      // No transcript to follow for this CLI: type the brief in, and watch the card.
      this.typeTask(session.id, task)
      this.crewTasks.set(tabId, task)
      void this.watchTurn(tabId).then((said) => this.crewDone(tabId, said))
      return `Sent to "${group!.displayTitle}". It is on it — you will be told when it finishes, so carry on.`
    }
    const result = await window.ember.crew.dispatch(tabId, session.id, task)
    if (!result.ok) return result.error ?? 'That session would not take the work.'
    this.crewTasks.set(tabId, task)
    return `Sent to "${group!.displayTitle}". It is on it — you will be told when it finishes, so carry on.`
  }

  /** A brief typed into an agent's prompt: one line, then Enter on its own, as a person would. */
  private typeTask(sessionId: string, task: string): void {
    window.ember.write(sessionId, task.replace(/\s*\r?\n\s*/g, ' ').trim())
    window.setTimeout(() => window.ember.write(sessionId, '\r'), App.SUBMIT_GAP_MS)
  }

  /**
   * Wait for a session's turn to finish, read off its card: it has to be seen working
   * first, then stop. Resolves with the tail of its screen — for CLIs Ember cannot read
   * a transcript of, the screen is what it said.
   */
  private async watchTurn(tabId: string, limitMs = 30 * 60_000): Promise<string> {
    const t0 = performance.now()
    let worked = false
    let quietSince = 0
    while (performance.now() - t0 < limitMs) {
      await new Promise((r) => window.setTimeout(r, 1000))
      const group = this.groups.find((g) => g.id === tabId)
      if (!group) return ''
      const state = group.aggregate(performance.now()).state
      if (state === 'working') {
        worked = true
        quietSince = 0
      } else if (worked || performance.now() - t0 > 20_000) {
        // Two quiet seconds in a row, so a pause between tool calls does not count.
        quietSince ||= performance.now()
        if (performance.now() - quietSince > 2000) break
      }
    }
    return this.screenTail(tabId)
  }

  /** The last lines on a session's screen, without the box-drawing and the prompt chrome. */
  private screenTail(tabId: string, max = 900): string {
    const text = this.groups.find((g) => g.id === tabId)?.focused?.visibleText() ?? ''
    const lines = text
      .split('\n')
      .map((l) => l.replace(/[│╭╮╰╯─━┃┏┓┗┛]/g, '').trim())
      .filter((l) => l && !/^[>›❯]\s*$/.test(l))
    return lines.slice(-14).join(' ').slice(-max)
  }

  /** A session finished work it was handed: say so wherever the orchestrator is being heard. */
  private crewDone(tabId: string, said: string): void {
    const group = this.groups.find((g) => g.id === tabId)
    const title = group?.displayTitle ?? tabId
    const task = this.crewTasks.get(tabId)
    this.crewNotes++
    const line = `Session "${title}" (${tabId}) has finished${task ? ` "${task.slice(0, 120)}"` : ''}. Its screen ends: ${said}`
    this.notice(line)
    void this.remote.note(line)
    this.flashToast(`"${title}" finished`)
  }

  /**
   * Open a tab, start Claude in it, and give it the brief — without blocking the call.
   *
   * Coming up takes several seconds, which is far too long to hold the floor for. So the
   * id comes back immediately and the rest happens behind the conversation: the task is
   * sent when the session announces itself, and a note arrives if it never does.
   */
  private async startCrewSession(task: string, directory: string, name: string): Promise<string> {
    const cwd = directory ? await this.resolveDirectory(directory) : undefined
    const group = await this.newGroup(undefined, cwd)
    if (name) group.customTitle = name.slice(0, 40)

    const session = group.focused
    if (!session) return 'The tab opened but has no shell in it.'

    // Start the chosen agent, then wait for it to come up before briefing it. Typing the
    // brief at a shell prompt would run it as a command.
    const agent = AGENTS[this.config.agent.default] ?? AGENTS.claude
    window.ember.write(session.id, `${[agent.bin, ...(agent.unattended ?? [])].join(' ')}\r`)
    if (agent.id === 'claude') void this.briefWhenReady(group.id, session.id, task)
    else void this.briefWhenOnScreen(group.id, session.id, task)

    return task
      ? `Opening a session${cwd ? ` in ${cwd.split(/[/\\]/).pop()}` : ''} as ${group.id}. It takes a few seconds to come up; the brief goes in the moment it does, and you will be told.`
      : `Opened ${group.id}${cwd ? ` in ${cwd.split(/[/\\]/).pop()}` : ''}. It is starting up.`
  }

  /**
   * A todo item becomes a Claude session: a new tab in this tab's folder, briefed with
   * the item and told how to tick it when it is done.
   */
  private async claudeFor(item: string): Promise<void> {
    const text = item.trim()
    if (!text) return
    const cwd = this.activeGroup?.focused?.cwd || ''
    const key = text.split(/\s+/).slice(0, 5).join(' ').replace(/"/g, '')
    const brief =
      `Take care of this item from my todo list: "${text}". ` +
      'Work it through to done. If it needs a decision or something only I can do, stop and tell me exactly what. ' +
      `When it is done, run: todo done "${key}"`
    await this.startCrewSession(brief, cwd, text.slice(0, 40))
    this.flashToast(`Claude is starting on: ${text.slice(0, 70)}`)
  }

  /** Poll until the new session has a Claude in it, then hand over the brief. */
  /**
   * The same for an agent with no transcript: it is up once its card says so (the shim
   * announces it in the title) and it has sat still for a moment — a TUI that is still
   * drawing its first screen swallows typed input.
   */
  private async briefWhenOnScreen(tabId: string, sessionId: string, task: string): Promise<void> {
    let upSince = 0
    let asked = false
    // Up to ten minutes: a first run in a folder can stop on a trust prompt that only the
    // person may answer, and they may be away from the keyboard.
    for (let i = 0; i < 1200; i++) {
      await new Promise((r) => window.setTimeout(r, 500))
      const group = this.groups.find((g) => g.id === tabId)
      const session = group?.panes.find((p) => p.id === sessionId)
      if (!group || !session) return
      const a = session.activity.current
      // Showing a picker of its own (a trust prompt, a login): the answer is the person's,
      // and a brief typed now would land in the picker.
      if (a.agent && a.attention === 'question') {
        if (!asked) {
          asked = true
          const line = `"${group.displayTitle}" is asking you something before it can start — answer it and the brief goes in.`
          this.flashToast(line)
          this.notice(line)
        }
        upSince = 0
        continue
      }
      if (!a.agent || a.state === 'working') {
        upSince = 0
        if (!a.agent && i > 90) break
        continue
      }
      upSince ||= performance.now()
      if (performance.now() - upSince < 2500) continue
      if (!task) return
      this.typeTask(sessionId, task)
      this.crewTasks.set(tabId, task)
      void this.watchTurn(tabId).then((said) => this.crewDone(tabId, said))
      return
    }
    this.notice(`Session ${tabId} never finished starting. Ask the user to look at it.`)
  }

  private async briefWhenReady(tabId: string, sessionId: string, task: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => window.setTimeout(r, 1000))
      if (!this.groups.some((g) => g.id === tabId)) return
      if (!(await window.ember.voice.ready(tabId))) continue

      if (!task) {
        window.ember.crew.follow(tabId)
        this.notice(`Session ${tabId} is up and idle.`)
        return
      }
      const result = await window.ember.crew.dispatch(tabId, sessionId, task)
      this.crewTasks.set(tabId, task)
      this.notice(
        result.ok
          ? `Session ${tabId} is up and has started on: ${task}`
          : `Session ${tabId} came up but would not take the work: ${result.error}`
      )
      return
    }
    this.notice(`Session ${tabId} never finished starting. Tell the user to look at it.`)
  }

  /** Match a spoken folder name against his real project directories. */
  private async resolveDirectory(said: string): Promise<string | undefined> {
    if (/[/\\]/.test(said)) return said
    const want = said.trim().toLowerCase()
    const projects = await window.ember.listProjects()
    const hit =
      projects.find((p) => p.name.toLowerCase() === want) ??
      projects.find((p) => p.name.toLowerCase().includes(want))
    return hit?.path
  }

  private async checkWork(tabId: string): Promise<string> {
    const group = this.groups.find((g) => g.id === tabId)
    const report = await window.ember.crew.report(tabId)
    const title = group?.displayTitle ?? tabId
    if (!report) {
      const a = group ? group.aggregate(performance.now()) : null
      if (!a) return `Nothing known about ${tabId}.`
      const task = this.crewTasks.get(tabId)
      // An agent Ember reads off the screen rather than from a transcript.
      if (task) return `"${title}" is ${a.state}. Task was: ${task}. Its screen ends: ${this.screenTail(tabId, 600)}`
      return `Nothing has been handed to "${title}". It is ${a.state}.`
    }
    const how = report.finished ? 'has finished' : `has been going for ${report.forMinutes} minutes`
    return `"${title}" ${how}. Task was: ${report.task}. It said: ${report.said || 'nothing yet'}`
  }

  /** What each tab was last asked to do, so a report can name the work. */
  private readonly crewTasks = new Map<string, string>()

  /** Hand-offs that have reported finishing. Counted whether or not a call heard them. */
  private crewNotes = 0


  private syncVoiceChrome(): void {
    this.orchestrator.setAgent(`via ${(AGENTS[this.config.agent.default] ?? AGENTS.claude).name}`)
    this.sidebar.setOrchestrator({
      // Deliberately not gated on the key. Hiding this button when OpenAI is not set up
      // hides the only way to reach the panel that says OpenAI is not set up — the
      // failure explains itself only if you can get to it.
      available: !!this.activeGroup,
      open: this.orchestrator.isOpen,
      call: 'idle',
      hearing: false,
      speaking: false,
      thinking: this.orchBusy,
    })
    this.titleBar.setVisualize(this.activeGroup?.focused?.activity.current.isClaude === true)
    this.titleBar.setPanel({
      available: !!this.activeGroup,
      open: this.activeGroup?.panel?.isOpen === true,
      unseen: this.activeGroup?.panel?.hasContent === true && this.activeGroup?.panel?.isOpen === false,
    })
  }

  /** Show or hide the active tab's panel by hand. */
  /**
   * Change the width of the left column.
   *
   * It used to animate as a grid track, a CSS variable stepped by a spring every frame.
   * Every one of those frames laid the whole window out again — and inside the stage that
   * meant resizing the terminals and, with a panel open, the webview, which is a
   * cross-process resize. Measured, those slides ran at a steady 30ms a frame.
   *
   * Now layout happens once. The track jumps straight to its final width, the column and
   * the stage are measured before and after, and each is given a transform equal to the
   * distance it just moved — so on screen nothing has moved yet. Springs then take those
   * transforms to zero, and the compositor does the slide with no layout in it at all.
   */
  private setColumn(width: number, animate = true): void {
    const sidebarRect = this.sidebar.el.getBoundingClientRect()
    const before = animate ? { sidebar: sidebarRect.left, stack: this.stack.getBoundingClientRect().left } : null
    const fromWidth = this.shifting ? this.sidebarWidth.value : sidebarRect.width
    this.columnW = Math.max(0, width)
    document.documentElement.style.setProperty('--sidebar-w', `${this.columnW}px`)
    if (!before) {
      this.finishShift()
      return
    }
    // The sidebar keeps its old width for now and eases to the new one; the track under it
    // is already final, so the stage has laid out once and will not again.
    this.sidebarWidth.set(fromWidth)
    this.sidebarWidth.to(this.columnW)
    this.sidebar.el.style.width = `${fromWidth.toFixed(1)}px`
    // Reading the rectangles is what makes layout happen, once, right here.
    const after = { sidebar: this.sidebar.el.getBoundingClientRect().left, stack: this.stack.getBoundingClientRect().left }
    this.shifts.sidebar.set(before.sidebar - after.sidebar)
    this.shifts.sidebar.to(0)
    this.shifts.stack.set(before.stack - after.stack)
    this.shifts.stack.to(0)
    for (const el of [this.sidebar.el, this.stack]) el.classList.add('is-shifting')
    this.shifting = true
    this.startPaneMotion()
  }

  private finishShift(): void {
    this.shifting = false
    for (const el of [this.sidebar.el, this.stack]) {
      el.style.transform = ''
      el.classList.remove('is-shifting')
    }
    this.sidebar.el.style.width = ''
    this.sidebar.syncPlateNow()
  }

  /**
   * The Visualize button: `/visualize` typed into the focused Claude session and sent, the
   * same way a panel's own buttons type. The skill decides what "this" is from the
   * conversation, so the button needs no argument.
   */
  private visualizeHere(): void {
    const session = this.activeGroup?.focused
    const agent = session?.activity.current.agent
    if (!session || !agent) {
      this.flashToast('Visualize needs an agent session in this tab')
      return
    }
    // Claude Code has the skill as a slash command; the others are asked in words, and
    // the panel's MCP instructions tell them the rest.
    window.ember.write(
      session.id,
      agent === 'claude' ? '/visualize' : 'Put what you just explained on the Ember panel with show_panel, as a diagram, table or mockup — whichever fits.'
    )
    window.setTimeout(() => window.ember.write(session.id, '\r'), App.SUBMIT_GAP_MS)
    session.focus()
  }

  private togglePanel(): void {
    const group = this.activeGroup
    if (!group) return
    group.ensurePanel(this.panelHooks(group)).toggle()
    this.startPaneMotion()
    this.syncVoiceChrome()
  }

  /** Arm "point at something on the panel and talk about it". */
  private togglePanelPicking(): void {
    const panel = this.activeGroup?.panel
    if (!panel?.hasContent) {
      this.flashToast('Nothing on the panel to point at yet')
      return
    }
    panel.togglePicking()
  }

  /** Point the focus ring at the focused pane, but only when there is a choice. */
  private updateFocusRing(): void {
    const group = this.activeGroup
    if (!group || !group.isSplit) {
      this.focusRing.hide()
      return
    }
    this.focusRing.track(group.focused?.el ?? null)
  }

  /** An empty name clears the override and hands the title back to the shell. */
  private renameGroup(id: string, title: string): void {
    const group = this.groups.find((g) => g.id === id)
    if (!group) return
    group.customTitle = title || null
    this.syncTabs()
  }

  private beginRename(): void {
    if (this.activeId) this.sidebar.beginRename(this.activeId)
  }

  /** Hide every piece of chrome so only the terminal remains. */
  private toggleZen(): void {
    const zen = document.body.classList.toggle('is-zen')
    this.setColumn(this.columnWidth())
    window.setTimeout(() => this.groups.forEach((g) => g.refit()), 300)
    this.flashToast(zen ? 'Zen mode — Ctrl+Shift+Enter to exit' : 'Zen mode off')
  }

  private toggleZoom(): void {
    this.activeGroup?.toggleZoom()
    this.startPaneMotion()
  }

  /** Move the viewport to the previous/next command mark. */
  private jumpCommand(dir: 1 | -1): void {
    const s = this.activeGroup?.focused
    if (!s) return
    const from = s.term.buffer.active.viewportY
    const target = s.blocks.step(from, dir)
    if (!target) {
      this.flashToast(dir === 1 ? 'No later command' : 'No earlier command')
      return
    }
    s.jumpToRow(target.markRow)
    sound.play('switch')
  }

  private copyLastOutput(): void {
    const text = this.activeGroup?.focused?.lastOutputText() ?? ''
    if (!text) return
    void navigator.clipboard.writeText(text)
    this.flashToast(`Copied ${text.split('\n').length} lines`)
  }

  private flashToast(message: string): void {
    const el = document.createElement('div')
    el.className = 'ember-toast'
    el.textContent = message
    document.body.appendChild(el)
    requestAnimationFrame(() => el.classList.add('is-in'))
    window.setTimeout(() => {
      el.classList.remove('is-in')
      window.setTimeout(() => el.remove(), 300)
    }, 1600)
  }

  /** Run the group/sidebar springs until everything has come to rest. */
  private startPaneMotion(): void {
    if (this.paneUnsub) return
    // Nothing heavy while anything moves: see Session.frozen.
    Session.frozen = true
    this.motionStartedAt = performance.now()
    this.lastMotionAt = this.motionStartedAt
    this.paneUnsub = ticker.add((dt) => {
      let moving = false
      this.lastMotionAt = performance.now()

      if (this.shifting) {
        const els = { sidebar: this.sidebar.el, stack: this.stack }
        let live = false
        for (const key of ['sidebar', 'stack'] as const) {
          const sp = this.shifts[key]
          sp.step(dt)
          if (!sp.settled) live = true
          els[key].style.transform = `translate3d(${sp.value.toFixed(2)}px, 0, 0)`
        }
        this.sidebarWidth.step(dt)
        if (!this.sidebarWidth.settled) live = true
        this.sidebar.el.style.width = `${Math.max(0, this.sidebarWidth.value).toFixed(1)}px`
        // The cards just changed width; the plate under the selected one follows this frame.
        this.sidebar.syncPlateNow()
        if (live) moving = true
        else this.finishShift()
      }

      this.ambient.step(dt)
      if (!this.ambient.settled) moving = true
      this.fx.style.setProperty('--fx-ambient', this.ambient.value.toFixed(3))

      for (const g of this.groups) {
        try {
          g.slide.step(dt)
          g.pop.step(dt)
          if (g.stepZoom(dt)) moving = true
          if (g.panel?.step_(dt)) moving = true
          g.applyPanel(this.config.panel.width)
          if (!g.slide.settled || !g.pop.settled) moving = true
        } catch (err) {
          // The ticker would catch this, but only after skipping the rest of the frame:
          // the style pass below would never run again and every tab would freeze where
          // it was. Land this one and carry on with the others.
          console.error('[ember] a tab threw while moving; landing it', { id: g.id, err })
          g.slide.set(g.slide.target)
          g.pop.set(g.pop.target)
        }
      }
      try {
        this.applyPaneStyles()
      } catch (err) {
        console.error('[ember] the pane style pass threw', err)
      }

      if (!moving) {
        this.paneUnsub?.()
        this.paneUnsub = null
        Session.frozen = false
        // A frame later, not in this one: the frame in which a motion lands is already
        // paying for its landing (a panel re-entering the flow, a column's layout), and a
        // refit on top — a pty resize per pane — made that one frame the heaviest of the
        // whole animation. Nobody can tell the terminal refitted 16ms later.
        requestAnimationFrame(() => {
          if (this.paneUnsub) return
          this.groups.forEach((g) => g.refit())
          // The repaint in activate() happens while the pane is still off at 85% and being
          // composited into position. Do it again once it has landed, so the frame that
          // comes to rest is one this app painted in full rather than one it inherited.
          this.activeGroup?.repaint()
        })
      }
    })
  }

  private applyPaneStyles(): void {
    const blurMax = this.config.motion.switchBlur
    for (const g of this.groups) {
      const off = g.slide.value
      const away = Math.min(1, Math.abs(off) / 60)
      const isActive = g.id === this.activeId
      const el = g.el

      // Strictly vertical. Any scale here reads as horizontal motion — a 5% shrink on
      // a 2300px pane moves each edge ~57px sideways — so the entrance is expressed
      // as a rise rather than a zoom, and the switch is a pure translate.
      const rise = (1 - g.pop.value) * 4
      el.style.transform = `translate3d(0, ${(off + rise).toFixed(2)}%, 0)`
      // Floored at 1% for a tab that is on its way in or out: at exactly 0 Chromium culls
      // the layer and drops the terminal's GPU surface, and bringing it back cost a 300ms
      // frame at the start of every entrance. A parked tab is hidden outright below.
      const parkedNow = !isActive && away >= 1
      const alpha = Math.max(0, 1 - away * 1.25) * Math.min(1, g.pop.value * 1.6)
      el.style.opacity = (parkedNow ? 0 : Math.max(0.01, alpha)).toFixed(3)
      el.style.filter = blurMax > 0 && away > 0.02 ? `blur(${(away * blurMax).toFixed(2)}px)` : ''
      el.classList.toggle('is-active', isActive)
      el.style.pointerEvents = isActive ? 'auto' : 'none'
      const parked = !isActive && away >= 1
      el.style.visibility = parked ? 'hidden' : 'visible'
      // A parked tab's terminals leave layout entirely. `visibility: hidden` alone is not
      // enough: xterm pauses its renderer on an IntersectionObserver, and a hidden element
      // still intersects, so every background tab kept drawing every damaged row into a
      // WebGL canvas nobody could see — and a session streaming in a tab you are not
      // looking at competed for the frame with the one you are typing into. Out of layout
      // it stops intersecting, xterm parks it, and only the parser keeps running. The
      // panel is left alone: a webview does not take kindly to display:none.
      g.setParked(parked && this.parking)
      el.style.zIndex = isActive ? '2' : '1'
    }
  }

  /** Fetch git status for any cwd we have not looked at recently. */
  private refreshGit(now: number): void {
    // Main caches git for 4s, so polling at the 5Hz activity rate meant nineteen of every
    // twenty round-trips were guaranteed cache hits — an IPC hop per session per tick to
    // be told what we already knew. Ask at the rate the answer can actually change.
    if (now - this.lastGitAt < App.GIT_POLL_MS) return
    this.lastGitAt = now

    for (const s of this.allSessions) {
      const cwd = s.cwd || s.initialCwd
      if (!cwd || this.gitPending.has(cwd)) continue
      this.gitPending.add(cwd)
      void window.ember
        .gitStatus(cwd)
        .then((st) => this.gitByCwd.set(cwd, st))
        .finally(() => this.gitPending.delete(cwd))
    }
  }

  private syncTabs(): void {
    const now = performance.now()
    this.refreshGit(now)
    this.showEmpty(this.groups.length === 0)
    this.ensureOnStage()

    // The tab you are watching cannot be waiting for you — you are already there.
    // Attention used to clear only when you switched *to* a group, so the session you
    // were sitting in front of went on claiming it needed you indefinitely.
    if (document.hasFocus()) this.activeGroup?.acknowledge()

    // A place (the overview, the list, the notes, the map as a tab of its own) has its
    // button at the top of the column, so it is not also a card in the list.
    const models: CardModel[] = this.groups.filter((g) => g.panes.length > 0).map((g) => {
      const activity = g.aggregate(now)
      const focused = g.focused
      const cwd = focused?.cwd || focused?.initialCwd || ''
      const isVoice = false
      return {
        id: g.id,
        title: g.displayTitle,
        subtitle: isVoice
          ? 'talking'
          : g.isSplit
            ? `${g.panes.length} panes`
            : (focused?.profile.name ?? ''),
        // A note or the todo list has no shell to take its colour from, so each takes a
        // theme colour of its own: a different kind of thing should read as one.
        accent: g.isTodo
          ? this.config.theme.cyan
          : g.isMap
            ? this.config.theme.green
          : g.isOverview
            ? this.config.theme.magenta
            : g.isNote
              ? this.config.theme.yellow
              : (focused?.profile.accent ?? this.config.theme.cursor),
        kind: g.isTodo ? 'todo' : g.isMap ? 'map' : g.isOverview ? 'overview' : g.isNote ? 'note' : 'shell',
        activity,
        paneCount: isVoice ? 1 : g.panes.length,
        reaction: this.reactionFor(g, now),
        git: this.gitByCwd.get(cwd) ?? null,
        url: focused?.urls[focused.urls.length - 1] ?? null,
        unread: g.id === this.activeId ? 0 : g.panes.reduce((n, p) => n + p.unread, 0),
        claude: this.config.claude.statusLine ? (this.claudeByTab.get(g.id) ?? null) : null,
      }
    })
    this.sidebar.render(models, this.activeId)
    this.sidebar.renderNav(this.activePlace(), {
      overview: models.filter((m) => m.activity.state === 'attention' && m.id !== this.activeId).length,
      todo: this.todoOpen,
    })

    // The overview reads the same refresh the cards do, so it is never staler than they are.
    if (this.groups.some((g) => g.overview)) {
      const rows = this.overviewRows(now)
      const orch = this.orchBrief()
      const plan = this.planFor()
      for (const g of this.groups) g.overview?.render(rows, orch, plan)
    }
    // Narration is only audible for the tab on screen, so the speech layer has to know
    // which that is — checked on the activity tick rather than only on switch, so it
    // cannot drift out of step with what is actually being shown.
    this.syncVoiceChrome()

    this.updateFocusRing()

    const needy = models.filter((m) => m.activity.state === 'attention' && m.id !== this.activeId)
    document.body.classList.toggle('has-attention', needy.length > 0)

    // No desktop toast and no taskbar flash: Ember is meant to be on screen all the
    // time, so the card's own amber state plus the chime is the signal. A duplicate
    // in the notification centre would just be noise to dismiss later.
    // One chime per session per minute, at most.
    //
    // The old code re-armed the moment a session left the attention state, so any
    // flicker in detection produced a fresh chime — which is what made it feel random.
    // A hard cooldown means even a mis-detection costs you one sound, not a stream,
    // and a session that genuinely still wants you is already saying so on its card.
    for (const m of needy) {
      const last = this.notifiedGroups.get(m.id) ?? 0
      if (now - last < App.ATTENTION_COOLDOWN_MS) continue
      this.notifiedGroups.set(m.id, now)
      sound.play('attention')
    }

    if (this.config.effects.ambient) {
      // Ambient tint tracks how much output is flowing right now.
      const busy = this.groups.filter((g) => g.aggregate(now).state === 'working').length
      this.ambient.to(Math.min(1, busy / Math.max(1, this.groups.length)))
      this.startPaneMotion()
    }
  }

  private reactionFor(g: Group, now: number): { kind: 'ok' | 'fail'; age: number } | null {
    const s = g.focused
    if (!s || !s.outcome) return null
    const age = (now - s.outcomeAt) / 1000
    if (age > 1.6) {
      s.outcome = null
      return null
    }
    return { kind: s.outcome, age }
  }

  private cycle(delta: number): void {
    if (this.groups.length < 2) return
    const cur = this.activeId ? this.indexOf(this.activeId) : 0
    const next = (cur + delta + this.groups.length) % this.groups.length
    void this.activate(this.groups[next]!.id)
  }

  private focusPane(delta: number): void {
    const group = this.activeGroup
    if (!group || !group.isSplit) return
    const idx = group.panes.findIndex((p) => p.id === group.focused?.id)
    const next = group.panes[Math.min(group.panes.length - 1, Math.max(0, idx + delta))]
    if (next) {
      group.focus(next.id)
      next.focus()
    }
  }

  /** Type into every pane of the active group at once. */
  /** Paste with terminal semantics: LF becomes CR, as xterm's own paste does. */
  private pasteClipboard(): void {
    void navigator.clipboard.readText().then((text) => {
      if (text) this.sendInput(text.replace(/\r?\n/g, '\r'))
    })
  }

  private sendInput(text: string): void {
    const group = this.activeGroup
    if (!group) return
    const targets = this.broadcasting ? group.panes : [group.focused]
    for (const t of targets) if (t) window.ember.write(t.id, text)
  }

  private async loadThemes(): Promise<ThemeConfig[]> {
    this.themes ??= await window.ember.listThemes().catch(() => [] as ThemeConfig[])
    return this.themes
  }

  /**
   * Everything the app can do, as one table.
   *
   * The palette shows the rows that are not hidden; `ember <words>` from a shell picks
   * the row whose `cli` matches and runs it with what follows. Titles are computed at
   * call time so a toggle reads as what it will do next.
   */
  private commandTable(): CommandSpec[] {
    return [
      ...this.contextRows(),
      { id: 'new', group: 'Session', title: 'New session', hint: 'Ctrl+Shift+T', cli: 'new [dir]', aliases: ['n'], run: (a) => void this.newGroup(undefined, a[0]) },
      {
        id: 'project',
        group: 'Session',
        title: 'Open project…',
        hint: '@',
        cli: 'open [name]',
        aliases: ['proj'],
        run: async (a) => {
          if (!a.length) return this.palette.show('@')
          const q = a.join(' ').toLowerCase()
          const projects = await window.ember.listProjects()
          const p = projects.find((x) => x.name.toLowerCase() === q) ?? projects.find((x) => x.name.toLowerCase().includes(q))
          if (!p) throw new Error(`no project "${a.join(' ')}"`)
          await this.newGroup(undefined, p.path)
          return `Opened ${p.name}`
        },
      },
      {
        id: 'run',
        group: 'Terminal',
        title: 'Run in this pane…',
        hint: '>',
        cli: 'run <cmd>',
        run: (a) => {
          if (!a.length) return this.palette.show('>')
          const line = a.join(' ')
          this.shellHistory.unshift(line)
          this.sendInput(`${line}\r`)
        },
      },
      { id: 'split-right', group: 'Split', title: 'Split pane right', hint: 'Alt+Shift++', cli: 'split right', aliases: ['s', 'sr'], run: () => void this.splitActive('row') },
      { id: 'split-down', group: 'Split', title: 'Split pane down', hint: 'Alt+Shift+-', cli: 'split down', aliases: ['sd'], run: () => void this.splitActive('column') },
      { id: 'zoom', group: 'Split', title: 'Zoom focused pane', hint: 'Ctrl+Shift+Z', cli: 'zoom', aliases: ['z'], run: () => this.toggleZoom() },
      {
        id: 'rename',
        group: 'Session',
        title: 'Rename session',
        hint: 'F2',
        cli: 'rename [name]',
        aliases: ['r'],
        run: (a) => {
          if (!a.length) return this.beginRename()
          if (this.activeId) this.renameGroup(this.activeId, a.join(' '))
        },
      },
      { id: 'close-pane', group: 'Session', title: 'Close focused pane', hint: 'Ctrl+Shift+W', cli: 'close', aliases: ['x', 'q'], run: () => this.closeFocusedPane() },
      { id: 'find', group: 'Terminal', title: 'Find in scrollback', hint: 'Ctrl+F', cli: 'find', aliases: ['/'], run: () => this.search.show() },
      { id: 'find-all', group: 'Terminal', title: 'Search all sessions…', hint: '?', cli: 'search [text]', run: (a) => this.palette.show(`?${a.join(' ')}`) },
      { id: 'tasks', group: 'Terminal', title: 'Run a project task…', hint: '!', cli: 'task', run: () => this.palette.show('!') },
      {
        id: 'prev-cmd',
        group: 'Navigate',
        title: 'Previous command',
        hint: 'Ctrl+Up',
        run: () => this.jumpCommand(-1),
      },
      { id: 'next-cmd', group: 'Navigate', title: 'Next command', hint: 'Ctrl+Down', run: () => this.jumpCommand(1) },
      { id: 'copy-out', group: 'Terminal', title: 'Copy last command output', hint: 'Ctrl+Shift+O', cli: 'copy', aliases: ['cp'], run: () => this.copyLastOutput() },
      {
        id: 'broadcast',
        group: 'Terminal',
        title: this.broadcasting ? 'Stop broadcasting input' : 'Broadcast input to all panes',
        hint: 'Ctrl+Shift+A',
        cli: 'broadcast',
        aliases: ['bc'],
        run: () => this.toggleBroadcast(),
      },
      { id: 'sidebar', group: 'View', title: 'Toggle sidebar', hint: 'Ctrl+B', cli: 'sidebar', aliases: ['sb'], run: () => this.toggleSidebar() },
      {
        id: 'theme',
        group: 'View',
        title: 'Change theme…',
        hint: 'Ctrl+Shift+P  #',
        cli: 'theme [name]',
        aliases: ['th'],
        run: async (a) => {
          if (!a.length) return this.palette.show('#')
          const want = a.join(' ').toLowerCase()
          const themes = await this.loadThemes()
          const t = themes.find((x) => x.name.toLowerCase() === want) ?? themes.find((x) => x.name.toLowerCase().includes(want))
          if (!t) throw new Error(`no theme called "${a.join(' ')}"; try: ${themes.map((x) => x.name).join(', ')}`)
          window.ember.saveConfig({ ...this.config, theme: structuredClone(t) })
          this.flashToast(t.name)
          return `Theme: ${t.name}`
        },
      },
      {
        id: 'settings',
        group: 'View',
        title: 'Settings',
        hint: 'Ctrl+,',
        cli: 'settings [tab]',
        aliases: ['cfg'],
        run: (a) => {
          const asked = a[0]?.toLowerCase() === 'claude' ? 'agent' : a[0]?.toLowerCase()
          const tab = asked ? SETTINGS_TABS.find((t) => t.toLowerCase() === asked) : undefined
          if (a[0] && !tab) throw new Error(`no settings tab "${a[0]}"; one of ${SETTINGS_TABS.join(', ').toLowerCase()}`)
          this.settings.toggle(this.config, tab as SettingsTab | undefined)
        },
      },
      { id: 'welcome', group: 'Help', title: 'Welcome & setup', hint: 'pick your agent CLI', cli: 'welcome', aliases: ['onboarding', 'setup'], run: () => this.showOnboarding() },
      {
        id: 'agent',
        group: 'Agent',
        title: 'Choose your agent CLI',
        cli: 'agent [name]',
        run: (a) => {
          if (!a.length) return void this.settings.show(this.config, 'Agent')
          const want = a.join(' ').toLowerCase()
          const spec = Object.values(AGENTS).find((x) => x.id === want || x.bin === want || x.name.toLowerCase().includes(want))
          if (!spec) throw new Error(`no agent "${a.join(' ')}"; one of ${Object.values(AGENTS).map((x) => x.id).join(', ')}`)
          window.ember.saveConfig({ ...this.config, agent: { ...this.config.agent, default: spec.id } })
          return `Agent: ${spec.name}`
        },
      },
      { id: 'notes', group: 'Notes', title: 'All notes', cli: 'notes', run: () => void this.goPlace('notes') },
      { id: 'note-new', group: 'Notes', title: 'New note', cli: 'note [text]', run: (a) => void this.openNotesIn(this.activeGroup, 'new', a.join(' ') || undefined) },
      { id: 'todo', group: 'Todo', title: 'Todo list', hint: 'Ctrl+Shift+D', cli: 'todo', aliases: ['t'], run: () => void this.goPlace('todo') },
      { id: 'map', group: 'Map', title: 'Architecture map of a project', hint: 'Ctrl+Shift+G', cli: 'map [project]', aliases: ['arch'], run: (a) => this.openMapIn(this.placeGroup('map'), a.join(' ') || undefined) },
      { id: 'overview', group: 'Sessions', title: 'Overview of every session', hint: 'Ctrl+Shift+S', cli: 'overview', aliases: ['ov', 'all', 'sessions'], run: () => void this.goPlace('overview') },
      {
        id: 'todo-check',
        group: 'Todo',
        title: 'Check todos',
        hint: 'mail, Slack, Jira, GitHub',
        cli: 'check',
        aliases: ['tc'],
        run: async () => {
          await this.openTodoIn(this.activeGroup)
          void this.activeGroup?.todo?.checkTodos()
        },
      },
      { id: 'keys', group: 'View', title: 'Keyboard shortcuts', hint: 'F1', cli: 'keys', aliases: ['h'], run: () => this.cheatsheet.toggle() },
      {
        id: 'panel',
        group: 'View',
        title: this.activeGroup?.panel?.isOpen ? 'Hide the panel' : 'Show the panel',
        hint: 'Ctrl+Shift+J',
        cli: 'panel [show|hide]',
        aliases: ['p'],
        run: (a) => {
          const open = this.activeGroup?.panel?.isOpen ?? false
          if (a[0] === 'show' && open) return
          if (a[0] === 'hide' && !open) return
          this.togglePanel()
        },
      },
      {
        id: 'panel-pick',
        group: 'View',
        title: 'Point at something on the panel',
        hint: 'Ctrl+Shift+E',
        cli: 'pick',
        run: () => this.togglePanelPicking(),
      },
      {
        id: 'devices',
        group: 'Voice',
        title: this.remote.joined ? 'Your devices…' : 'Connect your phone',
        cli: 'devices',
        // The phone link goes through a relay Deep Answer Labs runs; until that is a real
        // public service it is Labs, like the call.
        run: () => {
          if (!this.config.labs?.enabled) return void this.flashToast('The phone link is a Labs feature — Settings › Labs')
          void this.pairSheet.show()
        },
      },
      {
        id: 'orchestrator',
        group: 'Voice',
        title: this.orchestrator.isOpen ? 'Hand the orchestrator something, or close it' : 'Hand the orchestrator something, or open it',
        hint: 'Ctrl+Shift+M',
        cli: 'orch [text]',
        aliases: ['o'],
        run: async (a) => {
          if (!a.length) return this.toggleOrchestrator()
          const r = await this.sendToOrchestrator(a.join(' '))
          return r.text
        },
      },
      { id: 'zen', group: 'View', title: 'Zen mode', hint: 'Ctrl+Shift+Enter', cli: 'zen', run: () => this.toggleZen() },
      {
        id: 'clear',
        group: 'Terminal',
        title: 'Clear screen',
        cli: 'clear',
        aliases: ['cls'],
        run: () => {
          const s = this.activeGroup?.focused
          if (s) {
            s.term.clear()
            window.ember.write(s.id, '\r')
          }
        },
      },
      {
        id: 'reset-terminal',
        group: 'Terminal',
        title: 'Reset terminal modes',
        hint: 'fixes stray mouse codes',
        cli: 'reset',
        run: () => {
          this.activeGroup?.panes.forEach((p) => p.resetModes())
          this.flashToast('Terminal modes reset')
        },
      },
      { id: 'maximize', group: 'Window', title: 'Toggle maximize', cli: 'maximize', aliases: ['max'], run: () => window.ember.window.toggleMaximize() },
      {
        id: 'visualize',
        group: 'Claude',
        title: 'Visualize this',
        hint: 'asks the Claude in this tab',
        cli: 'visualize',
        aliases: ['v', 'viz'],
        run: () => this.visualizeHere(),
      },
      // Shell only: these need an argument, or print, which a palette row cannot.
      {
        id: 'list',
        group: 'Session',
        title: 'The open tabs',
        cli: 'list',
        aliases: ['ls'],
        hidden: true,
        run: () =>
          this.groups
            .map((g, i) => `${g.id === this.activeId ? '*' : ' '} ${i + 1}. ${g.displayTitle}${g.focused?.cwd ? `  ${g.focused.cwd}` : ''}`)
            .join('\n') || 'no sessions',
      },
      {
        id: 'focus',
        group: 'Session',
        title: 'Switch to a tab',
        cli: 'focus <n|name>',
        aliases: ['f', 'go'],
        run: async (a) => {
          const id = this.resolveTab(a.join(' '))
          if (!id) throw new Error(`no tab "${a.join(' ')}"; ember list shows them`)
          await this.activate(id)
        },
      },
    ]
  }

  /**
   * Rows that exist only where they make sense: `del` inside a note, `add` and `done` on
   * the todo list, `back` on either. They sit before the general rows, so inside the
   * notes `new` means a new note and `open` a note rather than a project.
   */
  private contextRows(): CommandSpec[] {
    const g = this.activeGroup
    const note = g?.note
    if (note) {
      return [
        { id: 'note-back', group: 'Note', title: note.isEditing ? 'Back to the list' : 'Back to the shell', hint: 'Esc', cli: 'back', aliases: ['b'], run: () => note.leave() },
        { id: 'note-del', group: 'Note', title: note.isEditing ? 'Delete this note' : 'Delete a note', cli: 'del [name]', aliases: ['delete', 'rm'], run: (a) => note.deleteNamed(a.join(' ')) },
        { id: 'note-open', group: 'Note', title: 'Open a note', cli: 'open <name>', aliases: ['o', 'e'], run: (a) => note.openNamed(a.join(' ')) },
        { id: 'note-new-here', group: 'Note', title: 'New note', cli: 'new [text]', run: async (a) => void (await note.create(a.join(' '))) },
        { id: 'note-list', group: 'Note', title: 'All notes', cli: 'list', aliases: ['ls'], run: () => void note.showList() },
        { id: 'note-view', group: 'Note', title: 'Show as text or as a list of items', cli: 'view text|list', run: (a) => note.setView(a[0] === 'list' ? 'tasks' : 'text') },
        { id: 'note-folder', group: 'Note', title: 'Show in the folder', cli: 'folder', run: () => note.reveal() },
      ]
    }
    const map = g?.map
    if (map) {
      return [
        { id: 'map-back', group: 'Map', title: 'Back', hint: 'Esc', cli: 'back', aliases: ['b'], run: () => map.leave() },
        { id: 'map-open', group: 'Map', title: 'Open a project map', cli: 'open <project>', aliases: ['o'], run: (a) => map.openNamed(a.join(' ')) },
        { id: 'map-new', group: 'Map', title: 'Set up a new project', cli: 'new', run: () => map.showForm(null) },
        { id: 'map-fit', group: 'Map', title: 'Fit the whole map', hint: 'F', cli: 'fit', run: () => map.fit(true) },
      ]
    }
    const todo = g?.todo
    if (todo) {
      return [
        { id: 'todo-back', group: 'Todo', title: 'Back to the shell', hint: 'Esc', cli: 'back', aliases: ['b'], run: () => todo.leave() },
        { id: 'todo-add', group: 'Todo', title: 'Add an item', cli: 'add <text>', aliases: ['a'], run: (a) => todo.add(a.join(' ')) },
        { id: 'todo-done', group: 'Todo', title: 'Tick an item', cli: 'done <words>', aliases: ['d'], run: (a) => todo.done(a.join(' ')) },
        { id: 'todo-clear-done', group: 'Todo', title: 'Clear the ticked items into the archive', cli: 'clear done', aliases: ['purge'], run: () => todo.clearDone() },
        { id: 'todo-archive', group: 'Todo', title: 'Show or hide the archive', cli: 'archive', aliases: ['archived', 'history'], run: () => todo.toggleArchive() },
        { id: 'todo-claude', group: 'Todo', title: 'Hand an item to a new Claude session', cli: 'claude <words>', aliases: ['cl'], run: (a) => todo.handOff(a.join(' ')) },
        { id: 'todo-dismiss', group: 'Todo', title: 'Take an item off the list without ticking it', cli: 'dismiss <words>', aliases: ['x', 'rm'], run: (a) => todo.dismiss(a.join(' ')) },
        { id: 'todo-open', group: 'Todo', title: 'Open where an item came from', cli: 'open <words>', aliases: ['o'], run: (a) => todo.openSource(a.join(' ')) },
        { id: 'todo-sources', group: 'Todo', title: 'Where Check todos looks', cli: 'sources', run: () => void this.settings.show(this.config, 'Todo') },
      ]
    }
    const overview = g?.overview
    if (overview && g.panes.length > 0) {
      return [
        {
          id: 'overview-back',
          group: 'Overview',
          title: 'Back to the shell',
          hint: 'Esc',
          cli: 'back',
          aliases: ['b'],
          run: () => {
            g.hideOverview()
            g.focusFirst()
            this.syncTabs()
          },
        },
      ]
    }
    return []
  }

  /** A palette row ran: what it printed goes on a toast, and so does what went wrong. */
  private runRow(spec: CommandSpec, args: string[]): void {
    Promise.resolve()
      .then(() => spec.run(args))
      .then(
        (out) => {
          if (typeof out === 'string' && out) this.flashToast(out)
        },
        (err: unknown) => this.flashToast(err instanceof Error ? err.message : String(err)),
      )
  }

  /** `ember …` typed in a tab: run a row of the table there, and hand back what it printed. */
  private async runCli(words: string[], tabId: string): Promise<string> {
    const specs = this.commandTable()
    if (!words.length || words[0] === 'help') return helpText(specs)
    const hit = matchCli(specs, words)
    if (!hit) throw new Error(`unknown command "${words.join(' ')}". Run ember on its own to list them.`)
    // The tab that typed it is the tab it acts on; a command from a background tab
    // brings that tab forward first, which is also what typing there would have done.
    if (tabId && tabId !== this.activeId && this.groups.some((g) => g.id === tabId)) await this.activate(tabId, true)
    const out = await hit.spec.run(hit.args)
    return typeof out === 'string' ? out : ''
  }

  private async buildCommands(query: string): Promise<Command[]> {
    // '>' runs the rest of the line in the focused pane; '@' opens a project.
    if (query.startsWith('>')) {
      const line = query.slice(1).trim()
      const out: Command[] = []
      if (line) {
        out.push({
          id: 'run',
          group: 'Run',
          title: line,
          hint: 'Enter',
          skipFilter: true,
          run: () => {
            this.shellHistory.unshift(line)
            this.sendInput(`${line}\r`)
          },
        })
      }
      for (const [i, past] of this.shellHistory.slice(0, 12).entries()) {
        if (past === line) continue
        if (line && !past.toLowerCase().includes(line.toLowerCase())) continue
        out.push({
          id: `hist-${i}`,
          group: 'History',
          title: past,
          skipFilter: true,
          run: () => this.sendInput(`${past}\r`),
        })
      }
      return out
    }

    // '?' searches every open session's scrollback and jumps to the hit.
    if (query.startsWith('?')) {
      const q = query.slice(1).trim()
      if (q.length < 2) {
        return [{ id: 'hint', group: 'Search', title: 'Type at least two characters…', skipFilter: true, run: () => {} }]
      }
      const hits: Command[] = []
      for (const g of this.groups) {
        for (const s of g.panes) {
          const buf = s.term.buffer.active
          const total = buf.baseY + s.term.rows
          for (let row = total - 1; row >= 0 && hits.length < 40; row--) {
            const text = buf.getLine(row)?.translateToString(true) ?? ''
            if (!text.toLowerCase().includes(q.toLowerCase())) continue
            hits.push({
              id: `hit-${s.id}-${row}`,
              group: g.displayTitle.slice(0, 14),
              title: text.trim().slice(0, 90),
              hint: `line ${row}`,
              skipFilter: true,
              run: () => {
                void this.activate(g.id).then(() => {
                  g.focus(s.id)
                  s.jumpToRow(Math.max(0, row - 2))
                })
              },
            })
          }
        }
      }
      return hits.length
        ? hits
        : [{ id: 'none', group: 'Search', title: `No match for "${q}"`, skipFilter: true, run: () => {} }]
    }

    // '!' lists runnable tasks from the focused session's directory.
    if (query.startsWith('!')) {
      const q = query.slice(1).trim().toLowerCase()
      const s = this.activeGroup?.focused
      const cwd = s?.cwd || s?.initialCwd || ''
      const tasks = await window.ember.listTasks(cwd)
      if (!tasks.length) {
        return [
          {
            id: 'no-tasks',
            group: 'Tasks',
            title: cwd ? 'No package.json scripts or Makefile targets here' : 'Unknown working directory',
            skipFilter: true,
            run: () => {},
          },
        ]
      }
      return tasks
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .map((t) => ({
          id: `task-${t.source}-${t.name}`,
          group: t.source === 'Makefile' ? 'make' : 'script',
          title: t.name,
          hint: t.detail,
          skipFilter: true,
          run: () => {
            this.shellHistory.unshift(t.command)
            this.sendInput(`${t.command}\r`)
          },
        }))
    }

    // '#' switches palette. There are far more themes than fit comfortably in the
    // settings grid, so they get a typing surface of their own; picking one applies it
    // immediately, which is the only way to judge a palette.
    if (query.startsWith('#')) {
      const q = query.slice(1).trim().toLowerCase()
      const themes = await this.loadThemes()
      const fold = (s: string): string =>
        s
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .toLowerCase()
      return themes
        .filter((t) => !q || fold(t.name).includes(fold(q)))
        .map((t) => ({
          id: `theme-${t.name}`,
          group: t.name === this.config.theme.name ? 'Current' : 'Theme',
          title: t.name,
          hint: `${t.background} · ${t.cursor}`,
          skipFilter: true,
          run: () => {
            window.ember.saveConfig({ ...this.config, theme: structuredClone(t) })
            this.flashToast(t.name)
          },
        }))
    }

    if (query.startsWith('@')) {
      const q = query.slice(1).trim().toLowerCase()
      const projects = await window.ember.listProjects()
      return projects
        .filter((p) => !q || p.name.toLowerCase().includes(q))
        .slice(0, 30)
        .map((p) => ({
          id: `proj-${p.path}`,
          group: p.git ? 'Repo' : 'Folder',
          title: p.name,
          hint: p.path,
          skipFilter: true,
          run: () => void this.newGroup(undefined, p.path),
        }))
    }

    const cmds: Command[] = this.commandTable()
      .filter((c) => !c.hidden)
      .map((c) => ({
        id: c.id,
        group: c.group,
        title: c.title,
        ...(c.hint ? { hint: c.hint } : {}),
        ...(c.cli ? { cli: c.cli } : {}),
        ...(c.aliases ? { aliases: c.aliases } : {}),
        run: (args: string[] = []) => this.runRow(c, args),
      }))

    // Offered only when a port collision actually happened, so it is a rescue rather
    // than a permanently-listed footgun.
    const busy = this.activeGroup?.focused?.busyPort
    if (busy) {
      cmds.unshift({
        id: 'free-port',
        group: 'Rescue',
        title: `Free port ${busy}`,
        hint: 'kills the listener',
        run: () => {
          void window.ember.killPort(busy).then((r) => {
            const s = this.activeGroup?.focused
            if (s) s.busyPort = 0
            this.flashToast(
              r.killed.length ? `Freed port ${busy} (pid ${r.killed.join(', ')})` : `Nothing was listening on ${busy}`,
            )
          })
        },
      })
    }

    for (const profile of this.config.profiles) {
      cmds.push({ id: `new-${profile.id}`, group: 'Session', title: `New ${profile.name}`, run: () => void this.newGroup(profile.id) })
      cmds.push({ id: `split-${profile.id}`, group: 'Split', title: `Split with ${profile.name}`, run: () => void this.splitActive('row', profile.id) })
    }

    this.groups.forEach((g, i) => {
      cmds.push({
        id: `go-${g.id}`,
        group: 'Go to',
        title: g.focused?.title ?? 'Session',
        hint: i < 9 ? `Ctrl+Alt+${i + 1}` : undefined,
        run: () => void this.activate(g.id),
      })
    })

    return cmds
  }

  private toggleBroadcast(): void {
    this.broadcasting = !this.broadcasting
    sound.play('toggle')

    document.body.classList.toggle('is-broadcasting', this.broadcasting)
    this.flashToast(this.broadcasting ? 'Broadcasting to all panes' : 'Broadcast off')
  }

  private wireGlobalKeys(): void {
    // Capture phase: xterm binds on the textarea, so without capture these chords
    // would be swallowed and forwarded to the shell as control codes.
    window.addEventListener(
      'keydown',
      (e) => {
        const ctrl = e.ctrlKey && !e.altKey
        const active = this.activeGroup?.focused ?? null

        // Ctrl+K is the command line, by request; Ctrl+Shift+P stays as the chord that
        // steals nothing from the program underneath (a terminal cannot transmit a shifted
        // control chord as a distinct sequence). Ctrl+K is kill-line in readline, which
        // is the one thing this costs the shell.
        if ((ctrl && e.shiftKey && e.code === 'KeyP') || (ctrl && !e.shiftKey && !e.altKey && e.code === 'KeyK')) {
          e.preventDefault()
          this.palette.toggle()
          return
        }
        if (ctrl && !e.shiftKey && e.code === 'Comma') {
          e.preventDefault()
          this.settings.toggle(this.config)
          return
        }
        if (e.code === 'F1') {
          e.preventDefault()
          this.cheatsheet.toggle()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'Enter') {
          e.preventDefault()
          this.toggleZen()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyD') {
          e.preventDefault()
          this.toggleTodo()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyS') {
          e.preventDefault()
          this.toggleOverview()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyG') {
          e.preventDefault()
          this.toggleMap()
          return
        }
        if (this.settings.isOpen || this.cheatsheet.isOpen) {
          if (e.code === 'Escape') {
            // An open font menu is the innermost surface, so it eats the first
            // Escape rather than taking the whole panel down with it.
            if (FontPicker.dismissOpen()) return
            this.settings.close()
            this.cheatsheet.close()
          }
          return
        }
        if (this.palette.isOpen) return

        // Ctrl+Up/Down navigates by command instead of by line.
        if (ctrl && !e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
          e.preventDefault()
          this.jumpCommand(e.code === 'ArrowUp' ? -1 : 1)
          return
        }
        if (ctrl && !e.shiftKey && e.code === 'KeyF') {
          e.preventDefault()
          this.search.show(active?.term.getSelection() ?? '')
          return
        }
        if (this.search.isOpen && e.code === 'Escape') return

        if (ctrl && e.shiftKey && e.code === 'KeyT') {
          e.preventDefault()
          void this.newGroup()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyW') {
          e.preventDefault()
          this.closeFocusedPane()
          return
        }
        if (e.code === 'F2' && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          this.beginRename()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyZ') {
          e.preventDefault()
          this.toggleZoom()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyA') {
          e.preventDefault()
          this.toggleBroadcast()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyM') {
          e.preventDefault()
          this.toggleOrchestrator()
          return
        }
        // Not Ctrl+Shift+P — that is the palette. Shift-modified because a bare Ctrl+J
        // is a line feed, which the shell is entitled to receive.
        if (ctrl && e.shiftKey && e.code === 'KeyJ') {
          e.preventDefault()
          this.togglePanel()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyE') {
          e.preventDefault()
          this.togglePanelPicking()
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyO') {
          e.preventDefault()
          this.copyLastOutput()
          return
        }
        if (ctrl && !e.shiftKey && e.code === 'KeyB') {
          e.preventDefault()
          this.toggleSidebar()
          return
        }
        // Alt+Shift +/- mirrors Windows Terminal's split bindings, and neither chord
        // collides with anything a shell expects.
        if (e.altKey && e.shiftKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
          e.preventDefault()
          void this.splitActive('row')
          return
        }
        if (e.altKey && e.shiftKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
          e.preventDefault()
          void this.splitActive('column')
          return
        }
        if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowUp')) {
          if (this.activeGroup?.isSplit) {
            e.preventDefault()
            this.focusPane(-1)
            return
          }
        }
        if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.code === 'ArrowRight' || e.code === 'ArrowDown')) {
          if (this.activeGroup?.isSplit) {
            e.preventDefault()
            this.focusPane(1)
            return
          }
        }
        if (ctrl && e.code === 'Tab') {
          e.preventDefault()
          this.cycle(e.shiftKey ? -1 : 1)
          return
        }
        if (e.ctrlKey && e.altKey && /^Digit[1-9]$/.test(e.code)) {
          e.preventDefault()
          const idx = Number(e.code.slice(5)) - 1
          const target = this.groups[idx]
          if (target) void this.activate(target.id)
          return
        }
        if (ctrl && e.shiftKey && e.code === 'KeyC') {
          const sel = active?.term.getSelection()
          if (sel) {
            e.preventDefault()
            void navigator.clipboard.writeText(sel)
          }
          return
        }
        if (ctrl && e.code === 'KeyV') {
          // Plain Ctrl+V pastes, like Windows Terminal — but only into the
          // terminal. xterm's hidden textarea *is* the terminal; any other
          // input or textarea keeps the browser's native paste.
          const t = e.target as HTMLElement | null
          const inField =
            !!t &&
            (t.tagName === 'INPUT' ||
              (t.tagName === 'TEXTAREA' && !t.classList.contains('xterm-helper-textarea')))
          if (!inField) {
            e.preventDefault()
            this.pasteClipboard()
          }
        }
      },
      { capture: true },
    )
  }

  dispose(): void {
    if (this.activityTimer !== null) window.clearInterval(this.activityTimer)
    this.paneUnsub?.()
    this.vitals.dispose()
    this.sidebar.dispose()
  }
}
