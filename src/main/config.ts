import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, realpathSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EmberConfig } from '../shared/types.js'
import { LOOK_INFO, isLook } from '../shared/looks.js'
import { BASALT, THEMES } from './themes.js'

/**
 * EMBER_HOME redirects config and state elsewhere.
 *
 * Test runs must not share `~/.ember` with the copy you actually use — probes edit
 * config.json and delete state.json, which would otherwise reach into a live session
 * and rewrite its settings out from under it.
 */
export const CONFIG_DIR = process.env['EMBER_HOME'] || join(homedir(), '.ember')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

/** Basalt's terminal face: DM Mono, bundled (styles/fonts.css), with system monospace fallbacks. */
export const TERMINAL_FONT = LOOK_INFO.basalt.mono

/**
 * Defaults. A new install starts in Basalt (opaque stone, Archivo and DM Mono); the look
 * is the one thing about the appearance a person picks, and pin() derives the palette
 * and the terminal face from it.
 */
export const DEFAULT_CONFIG: EmberConfig = {
  defaultProfile: 'pwsh',
  profiles: [
    {
      id: 'pwsh',
      name: 'PowerShell 7',
      command: 'pwsh.exe',
      args: ['-NoLogo'],
      accent: '#F2A43A',
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
    family: TERMINAL_FONT,
    size: 13,
    weight: 400,
    lineHeight: 1.16,
    letterSpacing: 0,
    features: { calt: 1, liga: 1 },
  },
  look: 'basalt',
  theme: { ...BASALT },
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
    // A real bottom gutter matters more than it looks: full-screen TUIs (Claude Code,
    // vim, lazygit) draw their status line on the very last row, and with a
    // fractional cell height that row otherwise sits flush against the edge and
    // reads as clipped.
    padding: { top: 12, right: 16, bottom: 22, left: 16 },
    sidebarWidth: 244,
  },
  scrollback: 10000,
  effects: {
    glow: 0,
    scanlines: 0,
    vignette: 0,
    ambient: false,
    groundMotion: true,
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
  panel: {
    width: 0.42,
    autoOpen: true,
    allowHtml: true,
  },
  claude: {
    usageLimits: false,
    statusLine: true,
  },
  agent: {
    default: 'claude',
    onboarded: false,
  },
  labs: {
    enabled: false,
  },
  updates: {
    check: true,
  },
}

/**
 * The chosen look over whatever else a file says: its palette, its terminal face at a
 * weight it has, no CRT overlay. A look is picked whole; its colours and faces are not
 * settings. Keys older configs carried (window opacity, backdrop, a second font, the
 * day/night pair) are dropped, so they do not linger in the file.
 */
function pin(c: EmberConfig): EmberConfig {
  const look = isLook(c.look) ? c.look : 'basalt'
  const out = {
    ...c,
    look,
    theme: { ...THEMES[look] },
    font: { ...c.font, family: LOOK_INFO[look].mono, weight: 400 },
    effects: { ...c.effects, scanlines: 0, vignette: 0 },
  } as EmberConfig & { appearance?: unknown }
  delete out.appearance
  const font = out.font as EmberConfig['font'] & { uiFamily?: unknown }
  delete font.uiFamily
  const win = { ...out.window } as EmberConfig['window'] & Record<string, unknown>
  for (const k of ['opacity', 'material', 'inactiveOpacity']) delete win[k]
  out.window = win
  return out
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
    cached = pin(merge(DEFAULT_CONFIG, raw))
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
    cached = pin(merge(DEFAULT_CONFIG, next))
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
    cached = pin(merge(DEFAULT_CONFIG, raw))
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
    // Watched by its long name. A folder opened by its 8.3 short name (C:\Users\AGON-M~1\…,
    // which is what %TEMP% often is, so every probe's EMBER_HOME) reports its files by their
    // short names too — CONFIG~1.JSO — and the filter below never sees config.json change.
    let dir = CONFIG_DIR
    try {
      dir = realpathSync.native(CONFIG_DIR)
    } catch {
      /* keep the name it was given */
    }
    watcher = watch(dir, (_event, filename) => {
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
