import type { AgentId, AgentStatus } from './agents'
/** Contract shared by main, preload and renderer. Keep it serialisable. */

export interface ShellProfile {
  id: string
  name: string
  /** Executable to launch. Resolved against PATH by the OS. */
  command: string
  args: string[]
  /** Working directory. `~` is expanded in main. */
  cwd?: string
  env?: Record<string, string>
  accent?: string
}

export interface FontConfig {
  /**
   * The app font. One family drives the terminal grid *and* the chrome around it, so
   * picking a font in settings re-fonts the whole window rather than just the shell.
   * A CSS stack is allowed — the first installed family wins, as usual.
   */
  family: string
  /**
   * Chrome-only override. Empty (the default) means the chrome follows `family`.
   * Exists because the terminal grid needs a monospaced font and the sidebar does
   * not, so a proportional UI font stays available without breaking cell alignment.
   */
  uiFamily: string
  size: number
  weight: number
  lineHeight: number
  letterSpacing: number
  /** OpenType features, e.g. { calt: 1, liga: 1 } — ported from Windows Terminal. */
  features: Record<string, number>
}

export interface CursorConfig {
  /** Spring stiffness for caret travel. Higher = snappier, lower = floatier. */
  stiffness: number
  /** Damping ratio. 1.0 = critically damped (no overshoot). <1 overshoots. */
  damping: number
  /** Stiffness of the lagging tail that produces the smear. Must be < stiffness. */
  trailStiffness: number
  /** 0 disables the trail entirely. */
  trailOpacity: number
  /** Outer glow radius in CSS px. */
  glow: number
  /** Fraction of cell width, for the 'bar' shape. */
  barWidth: number
  shape: 'block' | 'bar' | 'underline'
  /** Idle breathing pulse, in seconds per cycle. 0 disables. */
  pulsePeriod: number
}

export interface MotionConfig {
  /** Master multiplier on every duration. 0 = instant (accessibility / benchmarking). */
  scale: number
  /**
   * Session switching is a spring, not a duration — these are the real controls.
   * Higher stiffness = faster arrival; damping below 1 overshoots slightly.
   * At the defaults the slide is ~90% done in 155ms and fully at rest by ~490ms.
   */
  slideStiffness: number
  slideDamping: number
  /** Only drives CSS transitions on chrome (cards, palette), not the pane slide. */
  tabSwitchMs: number
  paneSpawnMs: number
  /** Blur applied to outgoing content during a tab switch, in px. */
  switchBlur: number
}

export interface ThemeConfig {
  name: string
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface EffectsConfig {
  /** Phosphor-style bloom over the grid, 0..1. 0 disables the overlay entirely. */
  glow: number
  /** CRT scanline strength, 0..1. */
  scanlines: number
  /** Corner darkening, 0..1. */
  vignette: number
  /** Tint the backdrop in response to how much output is flowing. */
  ambient: boolean
  /** New output rises into place. Auto-suppressed above `outputMotionMaxRate`. */
  outputMotion: boolean
  /** Chars/sec above which output motion is skipped, so a firehose stays instant. */
  outputMotionMaxRate: number
  /** Shed effects automatically when frame time slips. */
  adaptive: boolean
}

export interface SoundConfig {
  enabled: boolean
  /** 0..1 master gain. Everything is synthesised, so there are no asset files. */
  volume: number
}

export interface ScrollConfig {
  /** Momentum scrolling with friction rather than discrete line jumps. */
  inertia: boolean
  /** Rubber-band overscroll at the ends of the scrollback. */
  elastic: boolean
  /** Lines per wheel notch. */
  speed: number
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  /** Number of changed entries; 0 means clean. */
  dirty: number
}

export interface TaskEntry {
  name: string
  detail: string
  /** The shell line to run. */
  command: string
  source: 'package.json' | 'Makefile'
}

/** Machine load, sampled in the main process. Percentages, 0-100. */
export interface VitalsState {
  cpu: number
  mem: number
}

/** One thing the computer-use daemon just did, as it reports it to the bridge. */
export interface DeskActivity {
  /** 'move' | 'click' | 'drag' | 'type' | 'look' | 'focus' | 'run' | 'scroll' */
  action: string
  /** Screen position in physical pixels, when the action has one. */
  x: number | null
  y: number | null
  /** "press Seven in Calculator", "type 12 chars", "look at Chrome" */
  label: string
  /** The tab whose Claude did it. */
  tab: string
  at: number
}

export type DeskReady = 'off' | 'starting' | 'ok' | 'installing' | 'no-python' | 'no-deps' | 'failed'

/** Computer use, as the sidebar shows it. */
export interface DeskState {
  /** The daemon is up and taking commands. */
  running: boolean
  /** An action landed in the last couple of seconds. */
  busy: boolean
  /** The Stop switch is on: the daemon is dead and `desk` refuses until Resume. */
  halted: boolean
  ready: DeskReady
  /** Why `ready` is not 'ok', in words for the strip's tooltip. */
  message: string
  last: DeskActivity | null
}

/** What main tells the cursor overlay page. Point is in the overlay window's CSS pixels. */
export interface DeskOverlayState {
  point?: { x: number; y: number }
  label?: string
  action?: string
  visible: boolean
  halted: boolean
  showStop?: boolean
}

/** One of the plan's rate-limit windows, as Anthropic's usage endpoint reports it. */
export interface ClaudeLimit {
  /** 'session' for the five-hour window, 'weekly' for the seven-day one, else the model it is scoped to. */
  label: string
  /** How much of the window is used, 0-100. */
  percent: number
  /** When the window resets, epoch ms; null when the endpoint gave none. */
  resetsAt: number | null
  /** The endpoint's own flag for the window currently binding. */
  active: boolean
}

/**
 * The plan's usage, polled by main from the same endpoint `/usage` in Claude Code reads,
 * with the OAuth token Claude Code keeps on this machine. No API key, no tokens spent.
 */
export interface ClaudeUsage {
  ok: boolean
  /** When this was fetched, epoch ms. 0 before the first fetch. */
  at: number
  /** 'max', 'pro', … from the credentials file; '' when unknown. */
  plan: string
  /** Session first, weekly second, model-scoped windows after. */
  limits: ClaudeLimit[]
  /** 'signed-out' when there is no usable token; otherwise the last error, or null. */
  error: string | null
}

/** Ember's own updates, from its GitHub releases (src/main/update.ts). */
export interface UpdateState {
  /** This build's version. */
  current: string
  /** The latest release's version, once known. */
  latest: string | null
  /** A newer release than this build exists. */
  available: boolean
  /** Installed by the installer, so it can replace itself; false for a portable copy. */
  installed: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'error'
  /** The last failure, or ''. */
  error: string
  /** When the latest release was last asked for, epoch ms; 0 before the first look. */
  checkedAt: number
}

/** What a Claude session's status line reports about itself, once per update. */
/** One object the user placed on a Loom canvas, as the session is told about it. */
export interface ScreenItem {
  title: string
  format: string
  /** The edge of the screen it holds, or 'floating'. */
  placed: string
  /** The diagram source, for a diagram lifted out of a reply. */
  source?: string
}

/** Tokens and dollars a session spent on Ember's own tools: what it wrote into them, re-reading that, and the tools' definitions. Estimates. */
export interface EmberCost {
  tabId: string
  calls: number
  outTokens: number
  carryTokens: number
  overheadTokens: number
  tokens: number
  usd: number
}

export interface ClaudeStatus {
  tabId: string
  sessionId: string
  /** The model's display name — 'Fable', 'Opus'. */
  model: string
  contextPercent: number | null
  contextSize: number | null
  costUsd: number | null
  durationMs: number | null
  cacheWarm: boolean | null
  at: number
}

export interface ClaudeConfig {
  /** Poll the plan's rate limits and show them beside CPU and memory. */
  usageLimits: boolean
  /** Give Ember's Claude sessions a status line and show its numbers on the tab's card. */
  statusLine: boolean
}

/** One row in the settings font picker. */
export interface FontOption {
  family: string
  /**
   * Reported by the OS. False for the suggestions Ember offers that this machine
   * does not have — the picker dims those rather than previewing a fallback and
   * letting it pass for the real thing.
   */
  installed: boolean
}

export interface ProjectEntry {
  name: string
  path: string
  /** True when the directory is a git working tree. */
  git: boolean
}

/**
 * This machine's membership of the Ember account.
 *
 * One key across every device the user owns, so the phone joins once and then sees a list —
 * personal laptop, work laptop — rather than pairing with each in turn. The relay routes
 * by a hash of this key and never receives the key itself.
 */
export interface Account {
  relay: string
  key: string
  deviceId: string
  deviceName: string
  at: string
}

/** Another device on the account, as the roster reports it. */
export interface RemoteDevice {
  id: string
  kind: 'desk' | 'phone'
  name: string
  online: boolean
  self: boolean
}

export interface EmberConfig {
  /**
   * Ember Hands — Ember's own pointer on the desktop. 'show' (the default): Claude may
   * point at things and explain them, never click. 'act': it may also click and type,
   * with STOP always on screen. 'off': neither.
   */
  hands?: 'off' | 'show' | 'act'
  defaultProfile: string
  profiles: ShellProfile[]
  font: FontConfig
  theme: ThemeConfig
  cursor: CursorConfig
  motion: MotionConfig
  window: {
    /** 0-100, matches Windows Terminal's `opacity`. Applied to the content layer. */
    opacity: number
    /**
     * Windows 11 system backdrop behind the content.
     *
     * 'acrylic' is the blur — the only real one available to an app on Windows 11,
     * and it is drawn only while Ember is the active window. `inactiveOpacity` is
     * what keeps the window see-through for the rest of the time.
     *
     * 'none' is not "opaque": it is real per-pixel transparency, see-through focused
     * or not, with no blur behind it at all.
     */
    material: 'acrylic' | 'mica' | 'tabbed' | 'none'
    /**
     * 0-100. Window alpha while Ember is *not* the active window, for the backdrop
     * modes only.
     *
     * Windows stops drawing a system backdrop the instant a window is deactivated and
     * fills it with a solid colour instead, so a blurred terminal would turn into a
     * grey slab exactly when you are trying to look past it. Fading the whole window
     * instead keeps it see-through — flat rather than frosted, but see-through. 100
     * disables the fade and accepts the slab.
     */
    inactiveOpacity: number
    padding: { top: number; right: number; bottom: number; left: number }
    /** Width of the session sidebar in px. */
    sidebarWidth: number
  }
  effects: EffectsConfig
  sound: SoundConfig
  scroll: ScrollConfig
  /**
   * Wrap the PowerShell prompt so it reports the working directory (OSC 9;9).
   * Without it Ember cannot know a session's cwd, which disables the git badge, the
   * task runner, cwd-inheriting splits, and restoring a session in the right folder.
   * Your existing prompt is preserved — it is wrapped, not replaced.
   */
  shellIntegration: boolean
  scrollback: number
  panel: PanelConfig
  claude: ClaudeConfig
  /** Which coding-agent CLI Ember's own AI features run through. Never an API key. */
  agent: AgentConfig
  /** How an agent tab shows by default: Ember's canvas, or the agent's own screen. Remembered. */
  agentView?: 'canvas' | 'cli'
  /** Ember Brain: one memory, instructions and skills for every agent. On unless turned off. */
  brain?: { sync: boolean }
  /**
   * Look for a new release on GitHub at start and every 6 hours. On unless turned off.
   * Clicking the version in the sidebar checks either way.
   */
  updates?: { check?: boolean }
  /**
   * Features that need an API key of their own or reach into one person's
   * accounts. Off in a fresh install: Ember's
   * promise is that it runs on the CLIs you already have and asks for no keys.
   */
  labs: { enabled: boolean }
  /**
   * The theme the sun/moon switch goes to for each side, by name. The house pair by
   * default; switching away from a theme remembers it as that side's choice, so someone
   * who lives in Tokyo Night by night and One Light by day gets those back.
   */
  appearance: { night: string; day: string }
}

export interface AgentConfig {
  /** The CLI every headless run uses. */
  default: AgentId
  /** Onboarding has been seen (finished or skipped). */
  onboarded: boolean
}


export interface PanelConfig {
  /** Fraction of the stage the panel takes when open, 0.2–0.8. */
  width: number
  /** Spring open by itself the first time a session pushes something. */
  autoOpen: boolean
  /**
   * Let a session render its own HTML, not just markdown.
   *
   * Panel content is model output, so it is treated as untrusted either way: it is
   * served from the bridge's own origin into a webview with no preload and no node,
   * which cannot reach `window.ember` whatever it contains. This only decides whether
   * raw HTML is honoured or shown as text.
   */
  allowHtml: boolean
}

/**
 * Everything the realtime page needs to place one call, and nothing else.
 *
 * `secret` is an ephemeral `ek_…` scoped to a single session, never the account key, and
 * `callsUrl` is carried rather than hardcoded so the page never has to be right about a
 * URL that has already moved once.
 */
export interface RealtimeAuth {
  ok: boolean
  secret?: string
  model?: string
  callsUrl?: string
  expiresAt?: number
  error?: string
}

/** One thing a narrated session did, already phrased for speech. */
export interface TranscriptEvent {
  tabId: string
  text: string
  kind: 'assistant' | 'tool' | 'result'
}

/** One answer offered by an `ask` panel, or one action chip on any panel. */
export interface PanelOption {
  /** What the button reads. */
  label: string
  /** What gets typed into the terminal when it is clicked. Defaults to `label`. */
  value?: string
  /** A line of smaller text under the label. */
  hint?: string
  /** False to put the value in the prompt without pressing Enter. Default true. */
  submit?: boolean
}

/** What a session asks the panel to show. */
export interface PanelPush {
  tabId: string
  title: string
  format: 'markdown' | 'code' | 'mermaid' | 'html' | 'url' | 'ask' | 'images' | 'view'
  content: string
  /** Language hint for 'code'. */
  language?: string
  /** The file it was shown from (show_file), so the canvas can edit a note in place. */
  file?: string
  /** The buttons on an `ask` panel. Ignored by every other format. */
  options?: PanelOption[]
  /** Show a free-text box under an `ask` panel's options. Default true. */
  freeText?: boolean
  /** Replace what is on the panel rather than pushing a new entry onto its stack. */
  replace?: boolean
  /**
   * Arrived without being asked for — an image a hook caught, not one Claude chose to show.
   * Such a push opens a closed panel but never takes the place of something else on an open one.
   */
  quiet?: boolean
  id: string
  at: number
  /**
   * Per-document secret, minted here and written into the rendered page.
   *
   * It is what lets a panel document talk back: the page posts it to `/panel/act`, and
   * nothing else on the machine has it. Stripped before the push crosses to the
   * renderer — the renderer has no use for it, and one fewer copy is one fewer leak.
   */
  act?: string
}

/**
 * Something the user did on a panel, on its way to the terminal.
 *
 * Both the authored kind (a button the model put there) and the ambient kind (text the
 * user typed at an element they picked) arrive as this. `submit` is the difference
 * between typing into the prompt and pressing Enter, and it is never true for anything
 * a page decided on its own.
 */
export interface PanelAct {
  tabId: string
  kind: 'send'
  /** For `send`: the line to type. */
  text?: string
  /** For `send`: press Enter afterwards. */
  submit?: boolean
  /** The document that asked, so the renderer can check it is the one the user is in. */
  doc?: string
  /**
   * Main saw the user press something in the page showing `doc` a moment ago. Only main
   * can see that for a page of its own (the panel's webview); for a frame inside the
   * window this is false and the renderer judges from the frame's focus instead.
   */
  gesture?: boolean
}

/** main -> renderer */
export interface PtyDataEvent {
  sessionId: string
  data: string
}

export interface PtyExitEvent {
  sessionId: string
  exitCode: number
  signal?: number
}

export interface SpawnRequest {
  sessionId: string
  profileId: string
  cols: number
  rows: number
  cwd?: string
  /**
   * The tab this shell belongs to, so anything it starts can find the right panel.
   *
   * It is the group's id rather than the session's: the panel belongs to the tab, so
   * two panes in one tab must address the same surface.
   */
  tabId?: string
  /**
   * 'canvas' for a Loom tab. Reaches the shell as EMBER_SURFACE, and through it the panel
   * MCP server, which then describes a canvas instead of a side panel.
   */
  surface?: 'canvas'
  /** An agent id (src/shared/agents.ts) the shell starts as soon as it is up, before any prompt. */
  agent?: string
}

/** What a Loom tab's transcript tail sends: lines as they are written, or a new session. */
export type CanvasFeed =
  | { tabId: string; kind: 'lines'; lines: Array<Record<string, unknown>> }
  /**
   * `fresh`: the new transcript holds no conversation from before the switch — `/clear`, or
   * `claude` started anew — so the canvas starts over instead of keeping history above a seam.
   */
  | { tabId: string; kind: 'switch'; file: string; first: boolean; fresh?: boolean }

/** Media handed to a Loom canvas by the session (show_media). */
export interface CanvasMedia {
  tabId: string
  id: string
  title: string
  items: Array<{ src: string; kind: 'image' | 'video' | 'audio'; name: string; caption?: string }>
}

/** A request to draw on the page a Loom canvas is showing. */
export interface CanvasAnnotate {
  tabId: string
  reqId: string
  marks: Array<{ selector?: string; text?: string; label?: string; note?: string }>
  clear: boolean
  url?: string
}

/** The plan, as a Loom canvas's steps card shows it (show_steps). */
export interface CanvasSteps {
  tabId: string
  title: string
  steps: Array<{ text: string; status: 'pending' | 'active' | 'done' }>
}

export interface CanvasAnnotateResult {
  ok: boolean
  found?: number
  missing?: string[]
  url?: string
  error?: string
}

/**
 * One note, as the list sees it. The body is not here on purpose: the list renders
 * dozens of these and needs a line of each, not the whole of any.
 */
export interface NoteMeta {
  /** The file name, which is also the identity. There is no separate id to drift. */
  id: string
  title: string
  preview: string
  /** mtime in ms, so the list can sort without asking anything else. */
  modified: number
  bytes: number
}

export interface SpawnResult {
  sessionId: string
  pid: number
  shell: string
}

/** Exposed on `window.ember` by the preload script. */
export interface EmberBridge {
  getConfig(): Promise<EmberConfig>
  spawn(req: SpawnRequest): Promise<SpawnResult>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  kill(sessionId: string): void
  /**
   * Ack-based flow control: the renderer reports how many chars xterm has actually
   * flushed, so main can pause the pty before the renderer drowns in a firehose.
   */
  ack(sessionId: string, chars: number): void
  onData(cb: (e: PtyDataEvent) => void): () => void
  onExit(cb: (e: PtyExitEvent) => void): () => void
  /** Fires when ~/.ember/config.json changes on disk. */
  onConfigChange(cb: (config: EmberConfig) => void): () => void
  /** Directories under the home folder worth opening a session in. */
  listProjects(): Promise<ProjectEntry[]>
  /** Built-in colour schemes. */
  listThemes(): Promise<ThemeConfig[]>
  /** Font families installed on this machine, for the settings picker. */
  listFonts(): Promise<FontOption[]>
  /** The shipped defaults, for the settings panel's reset button. */
  defaultConfig(): Promise<EmberConfig>
  /** Persist an edited config; the file watcher then applies it everywhere. */
  saveConfig(next: EmberConfig): void
  /** Branch + dirty count for a working directory, or null if it is not a repo. */
  gitStatus(cwd: string): Promise<GitStatus | null>
  /** package.json scripts and Makefile targets in a directory. */
  listTasks(cwd: string): Promise<TaskEntry[]>
  /** Kill whatever is listening on a port. */
  killPort(port: number): Promise<{ killed: number[]; error?: string }>
  /** The right-hand panel a session draws on. Only live in the v2 experience. */
  /** A Loom tab: its session's transcript, media and page annotations. */
  canvas: {
    /** Start tailing the tab's transcript from its first line. Feeds arrive on onFeed. */
    watch(tabId: string): Promise<boolean>
    unwatch(tabId: string): void
    /** Read whatever has been appended right now, ahead of the next poll. */
    drain(tabId: string): Promise<boolean>
    onFeed(cb: (feed: CanvasFeed) => void): () => void
    /** Make a local image or video loadable by the canvas. */
    media(path: string): Promise<{ src: string; kind: 'image' | 'video' | 'audio'; name: string } | { error: string }>
    /** Host a small document (a mermaid diagram) on the bridge; returns its URL. */
    doc(tabId: string, title: string, format: 'markdown' | 'mermaid' | 'code' | 'html' | 'view', content: string): Promise<string>
    /** A quick question about one object, answered on the side — not a turn of the session. */
    sideAsk(question: string, about: string, source: string, cwd?: string): Promise<{ ok: boolean; text: string; error?: string }>
    /** How a document rendered (a diagram that failed to parse), for the session that showed it. */
    docStatus(id: string, status: { ok: boolean; error: string; repaired: boolean }): void
    /** Show a file on the tab's canvas by path (a note, the todo list, anything show_file takes). */
    showFile(tabId: string, path: string, title?: string): Promise<{ ok?: boolean; title?: string; error?: string }>
    onMedia(cb: (m: CanvasMedia) => void): () => void
    onAnnotate(cb: (a: CanvasAnnotate) => void): () => void
    /** Point at something on this canvas with Ember's pointer; answer with pointed(). */
    onPoint(cb: (p: { tabId: string; reqId: string; object: string; text: string; say: string; step?: number; steps?: number }) => void): () => void
    pointed(reqId: string, result: { ok: boolean; error?: string; found?: string }): void
    annotated(reqId: string, result: CanvasAnnotateResult): void
    onSteps(cb: (s: CanvasSteps) => void): () => void
    /** Tell main what the user has placed on this tab's canvas, for the session's on_screen tool. */
    screen(tabId: string, items: ScreenItem[]): void
    /** What a subagent of this tab's session is doing now, read from its own log. */
    onAgent(cb: (a: { tabId: string; agentId: string; action: string; at: number }) => void): () => void
    /** What Ember's own tools have cost this tab's session so far. */
    onCost(cb: (c: EmberCost) => void): () => void
    /**
     * Which agent CLI a tab is running now (null when it exits), for tabs whose agent is not
     * Claude Code: main then follows that agent's own session log (docs/specs/providers.md).
     */
    tabAgent(tabId: string, agent: string | null, cwd: string, since: number): void
    /** Write a handoff brief (switching a tab to another agent); returns its path. */
    handoff(text: string): Promise<string>
  }
  panel: {
    /** Base URL of the local bridge, for the panel webview to load documents from. */
    origin(): Promise<string>
    /** A session pushed something to a tab's panel. */
    onPush(cb: (push: PanelPush) => void): () => void
    /** A session asked for a tab's panel to be emptied. */
    onClear(cb: (e: { tabId: string }) => void): () => void
    /**
     * The user pressed something on a panel, or moved the caret into one of its
     * fields. Comes back through the bridge because the panel document is on another
     * origin in a webview and has no other way to reach this process.
     */
    onAct(cb: (e: PanelAct) => void): () => void
    /** Drop a closed tab's panel history so a reused id cannot inherit it. */
    forget(tabId: string): void
    /** The same document the panel shows, rendered for a phone over the relay. */
    render(push: PanelPush): Promise<string>
  }
  /**
   * The realtime call: OpenAI's model is the ears and mouth, the Claude session in the
   * tab is the brain. Only the second half knows anything.
   */
  notes: {
    /** Every note, newest first. */
    list(): Promise<NoteMeta[]>
    read(id: string): Promise<string | null>
    /** Writes, and returns the id — which changes if the title did. */
    save(id: string, body: string): Promise<{ ok: boolean; id: string; error?: string }>
    create(body?: string): Promise<NoteMeta | null>
    /** To the recycle bin, not into nothing. */
    remove(id: string): Promise<boolean>
    /** The folder itself, for "show me these in Explorer". */
    reveal(id?: string): void
    dir(): Promise<string>
    /** The `note` / `notes` shell functions, arriving via the bridge. */
    /**
     * `notes` (list), `note` (a fresh page, with the words that followed it) or a specific
     * note. `tabId` is the tab whose shell asked, so the note opens in that tab.
     */
    onOpen(cb: (e: { mode?: 'list' | 'new' | 'open' | 'todo'; text?: string; id?: string; tabId?: string }) => void): () => void
    /** A note was written or removed by something other than this window — a Claude session, usually. */
    onChanged(cb: (e: { id: string; was?: string; deleted?: boolean }) => void): () => void
  }
  /**
   * This machine's membership of the Ember account, and the devices on it.
   *
   * `create()` starts an account; `join()` adds this machine to one that exists, from its
   * code. Every device holds the same key, which is what lets the phone show a list of
   * laptops rather than being paired to one of them.
   */
  /** Ember Brain: one memory, instructions and skills for every agent (src/main/brain.ts). */
  brain: {
    status(): Promise<BrainStatus>
    sync(): Promise<BrainStatus>
  }
  remote: {
    account(): Promise<Account | null>
    create(): Promise<Account>
    join(relay: string, key: string): Promise<Account>
    rename(name: string): Promise<Account | null>
    leave(): Promise<boolean>
  }
  /** CPU and memory load of this machine. */
  vitals: {
    state(): Promise<VitalsState>
    onState(cb: (s: VitalsState) => void): () => void
  }
  /** Computer use: is a Claude driving the desktop, what is it doing, and the Stop switch. */
  desk: {
    state(): Promise<DeskState>
    halt(): void
    resume(): void
    onState(cb: (s: DeskState) => void): () => void
  }
  /** The coding-agent CLIs on this machine: which are installed, and whether one answers. */
  agents: {
    detect(withVersions?: boolean): Promise<AgentStatus[]>
    ping(id: AgentId): Promise<{ ok: boolean; text: string; error?: string; ms: number }>
  }
  /** The Claude plan's rate limits, polled by main. */
  usage: {
    state(): Promise<ClaudeUsage>
    /** Fetch now rather than at the next tick. */
    refresh(): void
    onState(cb: (u: ClaudeUsage) => void): () => void
  }
  /** Ember's own updates. */
  update: {
    state(): Promise<UpdateState>
    /** Ask for the latest release now. */
    check(): Promise<UpdateState>
    /** Download, check, install silently and restart into the new version. */
    install(): void
    onState(cb: (s: UpdateState) => void): () => void
  }
  /** What the Claude session in a tab reports through its status line. */
  claude: {
    onStatus(cb: (s: ClaudeStatus) => void): () => void
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
  }
  platform: {
    homedir: string
    /** Where a dropped file lives on disk; '' for one that is not a file on disk. */
    pathForFile(file: File): string
  }
  /** `ember <words>` from a shell, relayed by main; the renderer answers by request id. */
  cmd: {
    onRun(cb: (e: { reqId: string; words: string[]; tabId: string }) => void): () => void
    reply(reqId: string, r: { result: string; error?: string }): void
  }
  /** The todo list's file: its own surface, not a note. */
  todo: {
    read(): Promise<string>
    write(body: string): Promise<boolean>
    /** Where cleared items go: `## date` sections, newest first. */
    readArchive(): Promise<string>
    writeArchive(body: string): Promise<boolean>
  }
  /** Probe-only readouts, and the watchdog log. */
  diag: {
    /** Append one entry to ~/.ember/diag.log; `ember diag` prints the tail. */
    log(entry: Record<string, unknown>): void
    /**
     * Main-process event-loop delay since the previous call, in ms. A stall here is a
     * stall in every pty at once: keystrokes and echoes both cross main.
     */
    loop(): Promise<{
      max: number
      p99: number
      mean: number
      pty: Record<string, { unacked: number; paused: boolean; pauses: number; pausedMs: number }>
    }>
    /** Push a real panel to a tab without a bridge token. Probe-only. */
    pushPanel(body: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }>
    /** The adapter Chromium is drawing with. */
    gpu(): Promise<string>
  }
}

/** What every agent can see of the shared brain. */
export interface BrainStatus {
  dir: string
  facts: number
  skills: number
  instructionsFrom: string | null
  syncedAt: string | null
  agents: Array<{ agent: string; file: string; present: boolean; synced: boolean; skills: number | null }>
}
