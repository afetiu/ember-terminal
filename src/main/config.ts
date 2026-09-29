import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EmberConfig } from '../shared/types.js'

/**
 * EMBER_HOME redirects config and state elsewhere.
 *
 * Test runs must not share `~/.ember` with the copy you actually use — probes edit
 * config.json and delete state.json, which would otherwise reach into a live session
 * and rewrite its settings out from under it.
 */
export const CONFIG_DIR = process.env['EMBER_HOME'] || join(homedir(), '.ember')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

/**
 * Defaults are deliberately ported from the user's Windows Terminal settings.json
 * (Nightfall Neon, CaskaydiaCove NF light, 70% acrylic, 14/12 padding) so the first
 * launch feels like the terminal they already tuned — only the motion is new.
 */
export const DEFAULT_CONFIG: EmberConfig = {
  defaultProfile: 'pwsh',
  profiles: [
    {
      id: 'pwsh',
      name: 'PowerShell 7',
      command: 'pwsh.exe',
      args: ['-NoLogo'],
      accent: '#C74EFF',
    },
    {
      id: 'winps',
      name: 'Windows PowerShell',
      command: 'powershell.exe',
      args: ['-NoLogo'],
      accent: '#5B8CFF',
    },
    {
      id: 'cmd',
      name: 'Command Prompt',
      command: 'cmd.exe',
      args: [],
      accent: '#6E5C8A',
    },
  ],
  font: {
    family: 'CaskaydiaCove NF, Cascadia Code, Consolas, monospace',
    // Empty on purpose: one font for the whole window unless you deliberately split
    // the chrome off it in settings.
    uiFamily: '',
    size: 13,
    weight: 300,
    lineHeight: 1.16,
    letterSpacing: 0,
    features: { calt: 1, liga: 1 },
  },
  theme: {
    name: 'Nightfall Neon',
    background: '#1A0E2E',
    foreground: '#D9D2EA',
    cursor: '#C74EFF',
    cursorAccent: '#1A0E2E',
    selectionBackground: '#55307A',
    black: '#1B1030',
    red: '#FF3B6B',
    green: '#4CE0B3',
    yellow: '#FFC857',
    blue: '#5B8CFF',
    magenta: '#C74EFF',
    cyan: '#2DE2E6',
    white: '#D6CCE8',
    brightBlack: '#6E5C8A',
    brightRed: '#FF6B8B',
    brightGreen: '#6EF7C8',
    brightYellow: '#FFD98A',
    brightBlue: '#8AB0FF',
    brightMagenta: '#E08BFF',
    brightCyan: '#7DF9FF',
    brightWhite: '#FFFFFF',
  },
  // Cursor, motion, window and effects below are the user's own tuned values, promoted
  // from his installed config so a fresh install starts where he ended up rather
  // than at my first guesses.
  cursor: {
    stiffness: 1000,
    damping: 0.82,
    trailStiffness: 900,
    trailOpacity: 1,
    glow: 40,
    barWidth: 0.22,
    shape: 'block',
    pulsePeriod: 3.2,
  },
  motion: {
    scale: 1,
    // Critically damped (1.0) so nothing overshoots. Very stiff: the switch is
    // essentially immediate, which is the feel he settled on.
    slideStiffness: 2000,
    slideDamping: 1.0,
    tabSwitchMs: 190,
    paneSpawnMs: 230,
    switchBlur: 0,
  },
  window: {
    opacity: 70,
    // Acrylic is the glass. Windows drops the backdrop for whichever window is not
    // active, which is why this was briefly 'none' — but 'none' buys constant
    // transparency by giving up blur entirely, and the blur is the look. So: keep
    // acrylic, and fade the window itself while it is inactive (see inactiveOpacity)
    // so the moment Windows swaps in its solid fill you are looking through the
    // window rather than at it.
    // Acrylic, by choice. It blurs whatever is behind the window live, on every frame the
    // window changes, where mica samples the wallpaper once; measured on the fast GPU at
    // 160Hz, acrylic still dropped frames in the heaviest motions (a 97ms palette open)
    // and mica did not. The user weighed that and kept acrylic — the live glass is the look.
    material: 'acrylic',
    inactiveOpacity: 100,
    // A real bottom gutter matters more than it looks: full-screen TUIs (Claude Code,
    // vim, lazygit) draw their status line on the very last row, and with a
    // fractional cell height that row otherwise sits flush against the edge and
    // reads as clipped.
    padding: { top: 12, right: 16, bottom: 22, left: 16 },
    sidebarWidth: 244,
  },
  scrollback: 10000,
  effects: {
    glow: 1,
    scanlines: 0,
    vignette: 0.48,
    ambient: true,
    outputMotion: true,
    // Above this, animating arrivals costs more than it adds — a build log should
    // stay instant. Roughly a screenful per second.
    outputMotionMaxRate: 24_000,
    adaptive: true,
  },
  sound: {
    enabled: true,
    volume: 1,
  },
  scroll: {
    inertia: true,
    elastic: true,
    speed: 3,
  },
  shellIntegration: true,
  todo: {
    gmail: true,
    outlook: true,
    slack: true,
    jira: true,
    github: true,
  },
  panel: {
    width: 0.42,
    autoOpen: true,
    allowHtml: true,
  },
  claude: {
    usageLimits: true,
    statusLine: true,
  },
  agent: {
    default: 'claude',
    onboarded: false,
  },
  labs: {
    enabled: false,
  },
}

/** Shallow-per-section merge: a user config may override any subset of keys. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k]
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = merge(cur, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

let cached: EmberConfig | null = null

export function loadConfig(): EmberConfig {
  if (cached) return cached
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true })
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
      cached = DEFAULT_CONFIG
      return cached
    }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    cached = merge(DEFAULT_CONFIG, raw)
    // A config written before Labs existed belongs to someone already using the
    // key-based features; switching them off under that person would be a regression.
    if (raw && typeof raw === 'object' && !('labs' in raw)) cached = { ...cached, labs: { enabled: true } }
  } catch (err) {
    // A broken config must never stop the terminal from opening.
    console.error(`[ember] config load failed, using defaults: ${(err as Error).message}`)
    cached = DEFAULT_CONFIG
  }
  return cached
}

/**
 * Write a config back to disk.
 *
 * The settings panel edits through this rather than mutating the running app: the
 * file is the single source of truth, and the existing watcher then applies the
 * change everywhere. One path in, one path out, no second code path to keep in sync.
 */
export function saveConfig(next: EmberConfig): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    cached = merge(DEFAULT_CONFIG, next)
    writeFileSync(CONFIG_PATH, JSON.stringify(cached, null, 2), 'utf8')
  } catch (err) {
    console.error(`[ember] could not save config: ${(err as Error).message}`)
  }
}

/**
 * Re-read the config from disk, replacing the cache.
 *
 * Returns null when the file is unparseable, so a half-saved file mid-keystroke
 * leaves the running app on its last good config rather than resetting it.
 */
export function reloadConfig(): EmberConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    cached = merge(DEFAULT_CONFIG, raw)
    return cached
  } catch {
    return null
  }
}

/**
 * Watch the config for edits. Debounced because editors routinely emit several
 * change events for a single save (truncate, then write, then rename).
 */
export function watchConfig(onChange: (config: EmberConfig) => void): () => void {
  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    watcher = watch(CONFIG_DIR, (_event, filename) => {
      if (filename && !String(filename).startsWith('config.json')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const next = reloadConfig()
        if (next) onChange(next)
      }, 120)
    })
  } catch (err) {
    console.error(`[ember] config watch unavailable: ${(err as Error).message}`)
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}

export function resolveHome(p: string | undefined): string {
  if (!p) return app?.getPath?.('home') ?? homedir()
  if (p.startsWith('~')) return join(homedir(), p.slice(1))
  return p
}
