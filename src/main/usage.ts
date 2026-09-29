import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ClaudeLimit, ClaudeUsage } from '../shared/types.js'

/**
 * The Claude plan's rate limits, for the sidebar strip.
 *
 * This is the endpoint `/usage` inside Claude Code reads, called with the OAuth token
 * Claude Code keeps in its credentials file after `/login`. It is a metadata call: no
 * model is invoked, nothing counts against the limits it reports, and no API key is
 * involved. What it costs is that the endpoint is Claude Code's, not a published one,
 * so the parser below reads two shapes and gives up quietly on a third rather than
 * throwing — a strip that shows nothing is the worst this can do.
 *
 * The token is read, never refreshed. The refresh token rotates on use, and rotating it
 * from outside Claude Code would sign Claude Code out. When the token has expired the
 * strip says so and waits; the next `claude` the user runs refreshes the file, and the
 * next poll picks the new token up.
 */

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
/** Once a minute while signed in: the windows are hours and days long, so this is plenty. */
const POLL_MS = 60_000
/** Signed out, or an error: nothing changes fast, and hammering a failing call helps nobody. */
const RETRY_MS = 5 * 60_000
/** Told to slow down: do. */
const THROTTLED_MS = 10 * 60_000

interface Credentials {
  accessToken: string
  expiresAt: number
  plan: string
}

function credentialsPath(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  return join(dir, '.credentials.json')
}

function readCredentials(): Credentials | null {
  try {
    const file = credentialsPath()
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: Record<string, unknown> }
    const o = raw.claudeAiOauth
    if (!o || typeof o['accessToken'] !== 'string' || !o['accessToken']) return null
    return {
      accessToken: o['accessToken'],
      expiresAt: Number(o['expiresAt'] ?? 0) || 0,
      plan: String(o['subscriptionType'] ?? ''),
    }
  } catch {
    return null
  }
}

/** A reset time as the endpoint writes it — ISO text, or epoch seconds or ms — to epoch ms. */
function when(v: unknown): number | null {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000
  return null
}

/**
 * The windows worth showing, in the order they are shown.
 *
 * The `limits` array is the newer, richer shape: one row per window, with the
 * model-scoped weekly windows that the older top-level `five_hour` / `seven_day` pair
 * does not have. Both are read so a response in either shape still fills the strip.
 */
function parseLimits(body: Record<string, unknown>): ClaudeLimit[] {
  const out: ClaudeLimit[] = []
  const rows = Array.isArray(body['limits']) ? (body['limits'] as Record<string, unknown>[]) : []
  for (const r of rows) {
    const percent = Number(r['percent'])
    if (!Number.isFinite(percent)) continue
    const kind = String(r['kind'] ?? '')
    const scope = (r['scope'] ?? null) as { model?: { display_name?: unknown }; surface?: unknown } | null
    const label =
      kind === 'session'
        ? 'session'
        : kind === 'weekly_all'
          ? 'weekly'
          : String(scope?.model?.display_name ?? scope?.surface ?? '')
    if (!label) continue
    out.push({ label, percent: Math.round(percent), resetsAt: when(r['resets_at']), active: r['is_active'] === true })
  }

  if (!out.length) {
    for (const [key, label] of [
      ['five_hour', 'session'],
      ['seven_day', 'weekly'],
    ] as const) {
      const w = body[key] as Record<string, unknown> | null | undefined
      const percent = Number(w?.['utilization'])
      if (!w || !Number.isFinite(percent)) continue
      out.push({ label, percent: Math.round(percent), resetsAt: when(w['resets_at']), active: false })
    }
  }

  const rank = (l: ClaudeLimit): number => (l.label === 'session' ? 0 : l.label === 'weekly' ? 1 : 2)
  return out.sort((a, b) => rank(a) - rank(b))
}

export class UsageWatcher {
  state: ClaudeUsage = { ok: false, at: 0, plan: '', limits: [], error: null }

  private timer: NodeJS.Timeout | null = null
  private enabled = false
  private inFlight = false

  constructor(private readonly onState: (u: ClaudeUsage) => void) {}

  /** Turned on and off from config. Off means no polling at all, not a hidden poll. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) void this.tick()
    else this.stop()
  }

  /** Fetch now — the user pressed the chip. */
  refresh(): void {
    if (this.enabled) void this.tick()
  }

  dispose(): void {
    this.enabled = false
    this.stop()
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.stop()
    this.timer = setTimeout(() => void this.tick(), ms)
    this.timer.unref?.()
  }

  /**
   * Publish a change. The last good limits are kept through an error, so a blip in the
   * network does not empty the strip; `ok` and `error` say how fresh they are.
   */
  private emit(patch: Partial<ClaudeUsage>): void {
    this.state = { ...this.state, ...patch, at: Date.now() }
    this.onState(this.state)
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.inFlight) return
    this.inFlight = true
    let next = POLL_MS
    try {
      const creds = readCredentials()
      if (!creds || (creds.expiresAt && creds.expiresAt < Date.now())) {
        this.emit({ ok: false, plan: creds?.plan ?? '', error: 'signed-out' })
        next = RETRY_MS
        return
      }

      const res = await fetch(ENDPOINT, {
        headers: {
          authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': `ember/${app.getVersion()}`,
        },
        signal: AbortSignal.timeout(10_000),
      })

      if (res.status === 401 || res.status === 403) {
        this.emit({ ok: false, plan: creds.plan, error: 'signed-out' })
        next = RETRY_MS
        return
      }
      if (res.status === 429) {
        this.emit({ ok: false, plan: creds.plan, error: 'throttled' })
        next = THROTTLED_MS
        return
      }
      if (!res.ok) {
        this.emit({ ok: false, plan: creds.plan, error: `HTTP ${res.status}` })
        next = RETRY_MS
        return
      }

      const body = (await res.json()) as Record<string, unknown>
      this.emit({ ok: true, plan: creds.plan, limits: parseLimits(body), error: null })
    } catch (err) {
      this.emit({ ok: false, error: (err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message })
      next = RETRY_MS
    } finally {
      this.inFlight = false
      if (this.enabled) this.schedule(next)
    }
  }
}
