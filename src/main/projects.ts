import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectEntry } from '../shared/types.js'

/** Directories that are never interesting to open a shell in. */
const SKIP = new Set([
  'node_modules',
  '.git',
  'AppData',
  'Application Data',
  'Cookies',
  'Local Settings',
  'NetHood',
  'PrintHood',
  'Recent',
  'SendTo',
  'Templates',
  'Start Menu',
  'My Documents',
  '.cache',
  '.vscode',
  '.nuget',
  '.dotnet',
  '.android',
  'OneDrive',
])

let cache: { at: number; entries: ProjectEntry[] } | null = null
const TTL_MS = 30_000

/**
 * Directories worth opening a session in.
 *
 * Only one level under the home folder, and git working trees are surfaced first —
 * that is where the actual projects live, and a deep recursive walk of a Windows
 * home directory is both slow and full of junk.
 */
export function listProjects(): ProjectEntry[] {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.entries

  const home = homedir()
  const entries: ProjectEntry[] = []

  try {
    for (const name of readdirSync(home)) {
      if (name.startsWith('$') || SKIP.has(name)) continue
      const full = join(home, name)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      entries.push({ name, path: full, git: existsSync(join(full, '.git')) })
    }
  } catch (err) {
    console.error(`[ember] project scan failed: ${(err as Error).message}`)
  }

  entries.sort((a, b) => (a.git === b.git ? a.name.localeCompare(b.name) : a.git ? -1 : 1))
  entries.unshift({ name: '~  (home)', path: home, git: false })

  cache = { at: Date.now(), entries }
  return entries
}
