import type { ShellProfile } from '../../shared/types.js'

export interface PtySpawnOptions {
  sessionId: string
  profile: ShellProfile
  cols: number
  rows: number
  cwd: string
  /** Wrap the prompt so it reports cwd via OSC 9;9. */
  shellIntegration: boolean
  /**
   * Bridge coordinates for the tab's visualisation panel, or undefined in the classic
   * experience. Present means two things happen: the shell inherits these variables,
   * and `claude` is shimmed to pick up the panel MCP server.
   */
  panel?: Record<string, string>
  /** Directories to put in front of PATH — Ember's own commands (`notes`, `note`). */
  bin?: string[]
  /** Variables every shell gets, in either experience. */
  env?: Record<string, string>
}

export interface PtySession {
  readonly sessionId: string
  readonly pid: number
  readonly shell: string
}

/**
 * Everything the app needs from a pseudoterminal backend.
 *
 * Deliberately narrow and free of node-pty types: the whole Electron/ConPTY layer
 * is replaceable with a Rust/Tauri host later without touching a line of UI code.
 */
export interface PtyStats {
  unacked: number
  paused: boolean
  /** Times the shell has been paused for the renderer to catch up. */
  pauses: number
  /** Total time it has spent paused, in ms. */
  pausedMs: number
}

export interface PtyHost {
  spawn(opts: PtySpawnOptions): PtySession
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  kill(sessionId: string): void
  /** Report chars the frontend has flushed, for backpressure. */
  ack(sessionId: string, chars: number): void
  killAll(): void
  /** Backpressure bookkeeping per live session, for the latency probe. */
  stats?(): Record<string, PtyStats>

  onData(cb: (sessionId: string, data: string) => void): void
  onExit(cb: (sessionId: string, exitCode: number, signal?: number) => void): void
}
