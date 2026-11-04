import type { Terminal } from '@xterm/xterm'
import type { Feed } from './Feed'

/**
 * What wraps one agent CLI in a tab's canvas, while that CLI runs in the tab's terminal.
 *
 * Ember is a terminal first: a tab is a shell, and when the person runs an agent in it
 * (`claude`), the tab puts a canvas over that agent's own screen — the same process,
 * never a second one — with a Canvas | CLI switch that only shows or hides the screen.
 * The canvas never shows any part of the agent's screen. It is drawn from what the agent
 * writes down (its transcript, through main's watcher), and the agent is driven by typing
 * into its own screen, the way the person would.
 *
 * A wrapper is the per-agent part of that: how to type a message, a picture, an interrupt
 * or "send now" into this agent's screen, which commands its `/` menu offers, and which
 * event sources it has besides the screen (Claude Code: its hooks). LoomView hosts it and
 * owns everything that is the same for every agent: the canvas, the layout, the switch.
 *
 * Claude Code is the first (ClaudeTui). Codex keeps its framed screen for now; the next
 * step is a CodexTui on this interface.
 */

export type WrapperPhase = 'starting' | 'idle' | 'working' | 'asking' | 'exited'

export interface WrapperState {
  phase: WrapperPhase
  /** The permission mode, as the agent names it ('default', 'acceptEdits', 'plan', …), '' unknown. */
  mode: string
  /** The model, as the agent last said it ('' unknown). */
  model: string
  effort: string
  /** The agent's own working line: "✶ Pondering… (12s · ↓ 88 tokens)". */
  live: { glyph: string; verb: string; detail: string } | null
  /** The session's name (`/rename`), if it has one. */
  title: string
  sessionId: string
  /** While starting: what the start is doing, in words ("Starting Claude Code · connecting 12 MCP servers… 4s"). */
  boot?: string
}

/** What the host (LoomView) gives a wrapper. */
export interface WrapperHost {
  readonly tabId: string
  readonly feed: Feed
  /** Where the composer goes. */
  readonly frame: HTMLElement
  /** Where cards, the queue, pictures, menus and banners go: right above the composer. */
  readonly above: HTMLElement
  /** The agent's terminal, to read its screen (as text) — never to show it. */
  readonly term: Terminal
  /** Bytes into the agent's terminal, as typed. */
  write(data: string): void
  /** The folder the agent runs in. */
  cwd(): string
  /** Is the agent's own screen (the CLI view) the one shown now? */
  inCli(): boolean
  /** Show the agent's own screen. */
  openCli(): void
  /** The state changed: the bar, the working line, the hint. */
  changed(): void
  /** The conversation started over (`/clear`): so does the canvas. */
  cleared(): void
  /** The composer or what is above it changed size. */
  relayout(): void
  toast(text: string): void
}

export interface AgentWrapper {
  readonly agent: string
  /** Where the person types on the canvas. */
  readonly input: HTMLTextAreaElement
  readonly state: WrapperState
  /** Something of the wrapper's is open over the canvas (a menu, a card, the queue). */
  readonly busy: boolean
  /** The agent's screen changed (called at most once a frame). */
  screen(): void
  /** The person switched views (true: to the agent's own screen). */
  view(cli: boolean): void
  /** Esc on the canvas: true when the wrapper used it. */
  escape(): boolean
  /** Shift+Tab: the next permission mode. */
  cycleMode(): void
  /** The models the bar can pick from, and picking one. */
  models(): Array<{ value: string; displayName: string; description: string }>
  setModel(value: string): void
  /** Send a message as the person, from a canvas action. */
  send(text: string): void
  /** Put text into the composer without sending it. */
  put(text: string): void
  dropFiles(files: File[]): void
  /** The agent exited: the tab is a shell again. */
  ended(): void
  /** The agent (re)started in the tab. */
  started(): void
  debug(): Record<string, unknown>
  dispose(): void
}
