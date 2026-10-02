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

/** What a Claude session's status line reports about itself, once per update. */
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

/**
 * What a tab's Claude session last said and is doing now, from its transcript, for the
 * overview. `said` is the last sentence or two of the last assistant text; `doing` the
 * tool call in flight, emptied when the turn ends.
 */
export interface SessionBrief {
  tabId: string
  sessionId: string
  cwd: string
  said: string
  saidAt: number
  doing: string
  doingAt: number
  turnEnded: boolean
  at: number
  /** The whole of the last reply, markdown as written, for a card opened up to read it. */
  full: string
  /** Tokens across the session's whole transcript, each message counted once. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** What it has changed: files touched and lines in and out, from its edit calls. */
  edits: { files: number; count: number; added: number; removed: number }
  /** When the transcript began, if it says. */
  startedAt: number
}

/**
 * One thing a session did, for the overview's log: an edit, a command, a lookup.
 * Taken from the transcript's tool calls, so it is what happened rather than what the
 * screen showed.
 */
export interface ActivityEntry {
  tabId: string
  at: number
  kind: 'edit' | 'write' | 'read' | 'search' | 'run' | 'agent' | 'web' | 'tool' | 'done'
  /** The line as the log shows it: "App.ts", "pnpm build", "finished". */
  text: string
  /** Full path or command, for the tooltip. */
  detail: string
  added: number
  removed: number
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

/** Where Check todos can look. The order is the order the toggles show in. */
export const TODO_SOURCES = ['gmail', 'outlook', 'slack', 'jira', 'github'] as const
export type TodoSource = (typeof TODO_SOURCES)[number]

export interface EmberConfig {
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
  /**
   * Where Check todos looks, on this machine. A work laptop has Outlook and Slack and no
   * Gmail; a personal one the other way round. The skill is told exactly these.
   */
  todo: {
    gmail: boolean
    outlook: boolean
    slack: boolean
    jira: boolean
    github: boolean
  }
  scrollback: number
  panel: PanelConfig
  claude: ClaudeConfig
  /** Which coding-agent CLI Ember's own AI features run through. Never an API key. */
  agent: AgentConfig
  /**
   * Features that need an API key of their own (the voice call, the key-based
   * orchestrator) or reach into one person's accounts. Off in a fresh install: Ember's
   * promise is that it runs on the CLIs you already have and asks for no keys.
   */
  labs: { enabled: boolean }
}

export interface AgentConfig {
  /** The CLI the map, check-todos and every headless run use. */
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

/** What the voice asked Claude, and what came back. */
export interface AskResult {
  ok: boolean
  text?: string
  /** The turn ran out of time; what's here is real but unfinished. */
  partial?: boolean
  error?: string
}

/** One line of a call, for the transcript strip. */
export interface VoiceLine {
  who: 'user' | 'voice'
  text: string
}

/** One message in the orchestrator's shared conversation, in OpenAI's chat shape. */
export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

export interface TurnResult {
  ok: boolean
  message?: TurnMessage
  error?: string
}

/** A session the voice handed work to has gone quiet. */
export interface CrewNote {
  tabId: string
  kind: 'progress' | 'done'
  text: string
}

/** What one session has been doing since work was handed to it. */
export interface CrewReport {
  tabId: string
  task: string
  forMinutes: number
  finished: boolean
  said: string
  /** How many transcript events of each kind reached this journal. Diagnostic. */
  seen: Record<string, number>
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
  format: 'markdown' | 'code' | 'mermaid' | 'html' | 'url' | 'ask'
  content: string
  /** Language hint for 'code'. */
  language?: string
  /** The buttons on an `ask` panel. Ignored by every other format. */
  options?: PanelOption[]
  /** Show a free-text box under an `ask` panel's options. Default true. */
  freeText?: boolean
  /** Replace what is on the panel rather than pushing a new entry onto its stack. */
  replace?: boolean
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
  /** The map: living architecture models of projects, kept by Claude. */
  map: {
    list(): Promise<MapSummary[]>
    load(id: string): Promise<MapBundle | null>
    /** Creates the project and starts the first build. */
    create(input: { name: string; brief: string; pollMinutes?: number }): Promise<MapProject>
    edit(id: string, patch: { name?: string; brief?: string; pollMinutes?: number }): Promise<MapProject | null>
    remove(id: string): Promise<boolean>
    build(id: string, rebuild?: boolean): void
    /** The cheap check; `force` runs Claude even when nothing moved. */
    check(id: string, force?: boolean): void
    cancel(id: string): void
    viewed(id: string): void
    ask(projectId: string, nodeId: string | null, question: string, askId: string): void
    cancelAsk(askId: string): void
    /** Show a file from the map in Explorer. */
    reveal(path: string): void
    history(id: string): Promise<MapHistoryEntry[]>
    version(id: string, version: number): Promise<MapModel | null>
    /** Start (true) or stop (false) receiving live session activity. */
    watchLive(on: boolean): void
    onLive(cb: (sessions: MapLiveSession[]) => void): () => void
    onChanged(cb: (e: { id: string; deleted?: boolean }) => void): () => void
    onJob(cb: (e: { id: string; job: MapJob | null }) => void): () => void
    onAsk(cb: (e: MapAskEvent) => void): () => void
  }
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
    /** Run `/check-todos` in the local Claude Code and return its report. Minutes, not seconds. */
    checkTodos(): Promise<{ ok: boolean; output: string; error?: string; lastCheckedAt?: string }>
    /** When this machine last checked, if ever. */
    todoState(): Promise<{ lastCheckedAt?: string; sources?: string[] }>
  }
  voice: {
    /** Put a spoken question to the Claude session in a tab and wait for the whole turn. */
    ask(tabId: string, sessionId: string, question: string): Promise<AskResult>
    /** Abandon whatever question is in flight for a tab — the call ended, or the tab did. */
    cancel(tabId: string): void
    /** Is there a Claude session in this tab for a question to reach? */
    ready(tabId: string): Promise<boolean>
    /** What the tab's transcript watcher is tailing. Diagnostic. */
    watch(tabId: string): Promise<unknown>
  }
  orch: {
    /** One orchestrator turn through the chosen agent CLI. No key. */
    cli(text: string, recap: string): Promise<{ ok: boolean; text: string; error?: string }>
    /** A tool call from that turn, for the renderer to run and answer with toolResult. */
    onTool(cb: (call: { reqId: string; run: string; name: string; args: Record<string, unknown> }) => void): () => void
    toolResult(reqId: string, result: string): void
    /** What the running turn is doing, a line at a time. */
    onProgress(cb: (line: string) => void): () => void
  }
  /**
   * This machine's membership of the Ember account, and the devices on it.
   *
   * `create()` starts an account; `join()` adds this machine to one that exists, from its
   * code. Every device holds the same key, which is what lets the phone show a list of
   * laptops rather than being paired to one of them.
   */
  remote: {
    account(): Promise<Account | null>
    create(): Promise<Account>
    join(relay: string, key: string): Promise<Account>
    rename(name: string): Promise<Account | null>
    leave(): Promise<boolean>
  }
  /**
   * Work handed to a session and left running — the difference between the voice being a
   * remote control and being an orchestrator. `voice.ask` blocks the call until the turn
   * finishes; this returns at once and reports back when the session goes quiet.
   */
  crew: {
    dispatch(tabId: string, sessionId: string, task: string): Promise<{ ok: boolean; error?: string }>
    report(tabId: string): Promise<CrewReport | null>
    /** Take what a session has said since the last drain. */
    drain(tabId: string): Promise<string>
    /** Watch a session without giving it work. */
    follow(tabId: string): void
    forget(tabId: string): void
    /** A followed session finished a turn. */
    onNote(cb: (note: CrewNote) => void): () => void
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
  /** What the Claude session in a tab reports through its status line. */
  claude: {
    onStatus(cb: (s: ClaudeStatus) => void): () => void
  }
  /** What every Claude session last said and is doing, for the overview surface. */
  overview: {
    all(): Promise<SessionBrief[]>
    onBrief(cb: (b: SessionBrief) => void): () => void
    /** The log so far, oldest first. */
    activity(): Promise<ActivityEntry[]>
    onActivity(cb: (e: ActivityEntry[]) => void): () => void
  }
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
  }
  platform: {
    homedir: string
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

// ---------------------------------------------------------------------------
// The map: a living architecture model of a project, kept by Claude, read by the user.
// ---------------------------------------------------------------------------

/** What a project on the map is, as it was set up. The model is what Claude found. */
export interface MapProject {
  id: string
  name: string
  /** In the user's words: what it is, what belongs to it, where to look. */
  brief: string
  /** Minutes between cheap checks of the watched sources. 0 = only by hand. */
  pollMinutes: number
  createdAt: string
}

export type MapNodeKind =
  | 'system'
  | 'group'
  | 'repo'
  | 'app'
  | 'service'
  | 'component'
  | 'module'
  | 'datastore'
  | 'queue'
  | 'infra'
  | 'external'
  | 'job'
  | 'doc'

export type MapStatus = 'ok' | 'warn' | 'down' | 'unknown'

export interface MapRef {
  label: string
  url?: string
  path?: string
}

export interface MapNode {
  /** Stable forever. Updates refer to it; the layout and the change history hang off it. */
  id: string
  name: string
  kind: MapNodeKind
  parent?: string
  summary: string
  /** Markdown: how it works, key files, config, how it is deployed. */
  details?: string
  tech?: string[]
  status?: MapStatus
  statusNote?: string
  /** A local folder, when the thing lives in one — where a change session opens. */
  path?: string
  sources?: MapRef[]
  /** Where it runs: "Heroku deepanswerlabs", "Cloudflare Pages", "local only". */
  deploy?: string
  /** The rest of the project's world, pinned to this part: risks, open PRs, costs, people… */
  notes?: MapNote[]
}

export type MapNoteType = 'risk' | 'question' | 'decision' | 'pr' | 'issue' | 'todo' | 'cost' | 'date' | 'person' | 'note'

export interface MapNote {
  type: MapNoteType
  text: string
  url?: string
}

export interface MapEdge {
  id: string
  from: string
  to: string
  label?: string
  /** What travels along it and how: a sentence or two. */
  detail?: string
  /** HTTPS, SQL, webhook, git push, DNS… */
  protocol?: string
  sources?: MapRef[]
}

/** A named path through the system: "Buyer downloads a zip". */
export interface MapFlow {
  id: string
  name: string
  summary: string
  steps: Array<{ node: string; text?: string }>
}

/** Something cheap to poll for movement. A moved watch is what wakes Claude. */
export interface MapWatch {
  kind: 'git' | 'github' | 'heroku' | 'url'
  target: string
  label?: string
}

export interface MapModel {
  version: number
  updatedAt: string
  overview: string
  nodes: MapNode[]
  edges: MapEdge[]
  watches: MapWatch[]
  flows: MapFlow[]
}

export interface MapChangeItem {
  node?: string
  text: string
  impact?: 'minor' | 'notable' | 'major'
}

/** One entry in a project's history: what moved, in architecture terms. */
export interface MapChange {
  id: string
  at: string
  kind: 'build' | 'update' | 'rebuild'
  /** The watches that woke it, or "by hand". */
  trigger: string[]
  summary: string
  items: MapChangeItem[]
  /** Every node the change touched — added, updated or removed. */
  touched: string[]
  version: number
  /** Parts that appeared in this change. */
  added?: string[]
  /** Parts that went, as they were — so the map can show where they used to be. */
  removed?: MapNode[]
}

export interface MapJob {
  kind: 'build' | 'update' | 'rebuild' | 'check'
  startedAt: string
  /** The last thing Claude said it was doing. */
  line: string
}

export interface MapState {
  fingerprints: Record<string, string>
  watchErrors: Record<string, string>
  lastCheckAt?: string
  lastViewedAt?: string
  lastError?: string
  job?: MapJob | null
}

export interface MapBundle {
  project: MapProject
  model: MapModel | null
  changes: MapChange[]
  state: MapState
}

export interface MapSummary {
  project: MapProject
  nodes: number
  version: number
  updatedAt?: string
  unseen: number
  job?: MapJob | null
  lastError?: string
}

/** A Claude session seen working somewhere on the machine, and the files it touched. */
export interface MapLiveSession {
  sessionId: string
  /** The Ember tab it runs in, when it runs in one. */
  tabId?: string
  cwd: string
  /** ms since epoch of its last transcript line. */
  lastAt: number
  lastText: string
  touches: Array<{ path: string; mode: 'edit' | 'read' | 'commit'; at: number }>
}

export interface MapHistoryEntry {
  version: number
  at: string
}

export interface MapAskEvent {
  askId: string
  kind: 'progress' | 'done' | 'error'
  text: string
}
