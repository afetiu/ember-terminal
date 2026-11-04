import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { clipboard, ipcMain, nativeImage } from 'electron'
import type { ClaudeCatalog, SlashCommandInfo } from '../shared/types.js'
import { resolveBin } from './agents.js'
import { answerHook, setHooked } from './bridge.js'
import { CONFIG_DIR } from './config.js'
import { cleanEnv } from './pty/ConPtyHost.js'

/**
 * What a Claude tab's canvas needs from outside the TUI it wraps.
 *
 * The canvas drives the real Claude Code TUI in the tab's terminal (LoomView, ClaudeTui):
 * its messages are typed into that TUI. Its `/` menu, though, cannot be read off a screen
 * the canvas never shows, so the command list (and the model list) comes from one short
 * run of Claude Code in its structured mode that only says `initialize` and exits —
 * cached under EMBER_HOME, refreshed once a day. The project's own commands and skills
 * are read from its folder, which is cheap.
 *
 * Also here: the `@` file search in a tab's folder, the clipboard picture an image paste
 * goes through, and the renderer's end of the permission hooks (bridge.ts).
 */

const CATALOG = join(CONFIG_DIR, 'claude-catalog.json')
const DAY = 24 * 60 * 60 * 1000
const INIT_TIMEOUT_MS = 60_000

type Json = Record<string, unknown>

let cached: ClaudeCatalog | null = null
let running: Promise<ClaudeCatalog | null> | null = null

function readCache(): ClaudeCatalog | null {
  try {
    if (!existsSync(CATALOG)) return null
    const c = JSON.parse(readFileSync(CATALOG, 'utf8')) as ClaudeCatalog
    return Array.isArray(c.commands) ? c : null
  } catch {
    return null
  }
}

/** One `claude` in structured mode, asked `initialize` and closed. Null if it would not say. */
function fetchCatalog(): Promise<ClaudeCatalog | null> {
  const bin = process.env['EMBER_CLAUDE_BIN'] || resolveBin('claude')
  if (!bin) return Promise.resolve(null)
  return new Promise((resolve) => {
    const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json']
    const env: NodeJS.ProcessEnv = { ...cleanEnv(), CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }
    delete env['NODE_OPTIONS']
    let child: ChildProcess
    try {
      const ext = extname(bin).toLowerCase()
      if (ext === '.mjs' || ext === '.js') child = spawn(process.execPath, [bin, ...args], { cwd: homedir(), env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
      else if (ext === '.cmd' || ext === '.bat') child = spawn([`"${bin}"`, ...args].join(' '), { cwd: homedir(), env, shell: true, windowsHide: true })
      else child = spawn(bin, args, { cwd: homedir(), env, windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    let buf = ''
    let settled = false
    const finish = (c: ClaudeCatalog | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin?.end()
      } catch {
        /* gone */
      }
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else child.kill()
      }
      resolve(c)
    }
    const timer = setTimeout(() => finish(null), INIT_TIMEOUT_MS)
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    child.stdin?.on('error', () => {})
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      let cut = buf.indexOf('\n')
      while (cut !== -1) {
        const line = buf.slice(0, cut).trim()
        buf = buf.slice(cut + 1)
        cut = buf.indexOf('\n')
        if (!line) continue
        try {
          const m = JSON.parse(line) as Json
          const r = (m['response'] ?? {}) as Json
          if (m['type'] === 'control_response' && r['request_id'] === 'ember-catalog') {
            const body = (r['response'] ?? {}) as Json
            finish(r['subtype'] === 'success' ? catalogFrom(body) : null)
          }
        } catch {
          /* not a line of the protocol */
        }
      }
    })
    child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: 'ember-catalog', request: { subtype: 'initialize', hooks: {} } })}\n`)
  })
}

function catalogFrom(r: Json): ClaudeCatalog {
  const commands: SlashCommandInfo[] = Array.isArray(r['commands'])
    ? (r['commands'] as Json[])
        .filter((c) => c && typeof c['name'] === 'string')
        .slice(0, 500)
        .map((c) => ({
          name: String(c['name']),
          description: String(c['description'] ?? '').slice(0, 300),
          argumentHint: String(c['argumentHint'] ?? ''),
          ...(Array.isArray(c['aliases']) ? { aliases: (c['aliases'] as unknown[]).map(String).slice(0, 8) } : {}),
        }))
    : []
  const models = Array.isArray(r['models'])
    ? (r['models'] as Json[])
        .filter((m) => m && typeof m['value'] === 'string')
        .slice(0, 20)
        .map((m) => ({ value: String(m['value']), displayName: String(m['displayName'] ?? m['value']), description: String(m['description'] ?? '') }))
    : []
  return { at: Date.now(), version: String(r['claude_code_version'] ?? ''), commands, models }
}

/** The cached list at once; a fresh one is fetched when the cache is a day old (or missing). */
export async function catalog(): Promise<ClaudeCatalog> {
  cached ??= readCache()
  const stale = !cached || Date.now() - cached.at > DAY
  if (stale && !running) {
    running = fetchCatalog()
      .then((c) => {
        if (c && c.commands.length) {
          cached = c
          try {
            writeFileSync(CATALOG, JSON.stringify(c))
          } catch {
            /* next time */
          }
        }
        return c
      })
      .finally(() => {
        running = null
      })
  }
  if (!cached && running) await running
  return cached ?? { at: 0, version: '', commands: [], models: [] }
}

/** A project's own commands and skills: `.claude/commands/*.md`, `.claude/skills/<name>/`. */
function projectCommands(cwd: string): SlashCommandInfo[] {
  const out: SlashCommandInfo[] = []
  if (!cwd || !existsSync(cwd)) return out
  const describe = (file: string): string => {
    try {
      const text = readFileSync(file, 'utf8').slice(0, 4000)
      const m = /^---[\s\S]*?\bdescription:\s*(.+)$/m.exec(text)
      return (m?.[1] ?? '').replace(/^["']|["']$/g, '').trim().slice(0, 200)
    } catch {
      return ''
    }
  }
  try {
    const dir = join(cwd, '.claude', 'commands')
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.md')) out.push({ name: f.slice(0, -3), description: `${describe(join(dir, f))} (project)`, argumentHint: '' })
  } catch {
    /* unreadable */
  }
  try {
    const dir = join(cwd, '.claude', 'skills')
    if (existsSync(dir))
      for (const d of readdirSync(dir, { withFileTypes: true }))
        if (d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md'))) out.push({ name: d.name, description: `${describe(join(dir, d.name, 'SKILL.md'))} (project)`, argumentHint: '' })
  } catch {
    /* unreadable */
  }
  return out.slice(0, 200)
}

// ------------------------------------------------------------------ @ files

const SKIP = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', '.venv', '__pycache__', 'target'])
const fileLists = new Map<string, { at: number; files: string[] }>()

/** Every file of a folder, relative and with forward slashes: git's list when it is a repo, else a bounded walk. */
function listFiles(cwd: string): string[] {
  const hit = fileLists.get(cwd)
  if (hit && Date.now() - hit.at < 20_000) return hit.files
  let files: string[] = []
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (git.status === 0 && git.stdout) files = git.stdout.split('\n').filter(Boolean).slice(0, 200_000)
  else {
    const stack = [cwd]
    while (stack.length && files.length < 20_000) {
      const d = stack.pop()!
      let entries
      try {
        entries = readdirSync(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.claude') continue
        const p = join(d, e.name)
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) stack.push(p)
        } else files.push(relative(cwd, p).replace(/\\/g, '/'))
      }
    }
  }
  fileLists.set(cwd, { at: Date.now(), files })
  return files
}

/** What `@query` offers: folders and files whose path holds the query, best matches first. */
export function searchFiles(cwd: string, query: string): string[] {
  if (!cwd || !existsSync(cwd)) return []
  const files = listFiles(cwd)
  const q = query.replace(/\\/g, '/').toLowerCase()
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  const scored: Array<[number, string]> = []
  const score = (p: string): number => {
    const lower = p.toLowerCase()
    if (!q) return p.endsWith('/') ? (p.split('/').length === 2 ? 0 : -1) : p.includes('/') ? -1 : 1
    const base = lower.replace(/\/$/, '').split('/').pop() ?? lower
    if (lower.startsWith(q)) return 0
    if (base.startsWith(q)) return 1
    if (base.includes(q)) return 2
    if (lower.includes(q)) return 3
    return -1
  }
  for (const p of [...dirs, ...files]) {
    const s = score(p)
    if (s >= 0) scored.push([s * 1000 + Math.min(999, p.length), p])
    if (scored.length > 5000) break
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
  return scored.slice(0, 30).map(([, p]) => p)
}

// ------------------------------------------------------------------ IPC

export function registerClaudeCatalog(): void {
  ipcMain.handle('ember:claude:catalog', async (_e, cwd: unknown) => {
    const c = await catalog()
    const own = projectCommands(typeof cwd === 'string' ? cwd : '')
    const seen = new Set(c.commands.map((x) => x.name))
    return { ...c, commands: [...c.commands, ...own.filter((x) => !seen.has(x.name))] }
  })
  ipcMain.handle('ember:files:search', (_e, cwd: unknown, query: unknown) =>
    typeof cwd === 'string' && cwd.length < 1000 ? searchFiles(cwd, String(query ?? '').slice(0, 300)) : []
  )
  // A picture for Claude Code's Alt+V, which reads the clipboard itself.
  ipcMain.handle('ember:clipboard:image', (_e, dataUrl: unknown) => {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) return false
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return false
    clipboard.writeImage(img)
    return true
  })
  ipcMain.on('ember:hook:hooked', (_e, tabId: unknown, on: unknown) => typeof tabId === 'string' && setHooked(tabId, on === true))
  ipcMain.on('ember:hook:answer', (_e, id: unknown, output: unknown) =>
    typeof id === 'string' && answerHook(id, output && typeof output === 'object' ? (output as Record<string, unknown>) : null)
  )
}
