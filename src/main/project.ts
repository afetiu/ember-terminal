import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitStatus, TaskEntry } from '../shared/types.js'

const run = promisify(execFile)

const gitCache = new Map<string, { at: number; value: GitStatus | null }>()
const GIT_TTL_MS = 4000

/**
 * Branch and dirty count for a working directory.
 *
 * `--porcelain=v2 --branch` gives both in one call, and the short-format output is
 * stable across git versions — parsing `git status` prose is not. Cached because the
 * sidebar asks for every visible session several times a second, and spawning git
 * that often would be the most expensive thing the app does.
 */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  if (!cwd) return null
  const hit = gitCache.get(cwd)
  if (hit && Date.now() - hit.at < GIT_TTL_MS) return hit.value

  let value: GitStatus | null = null
  try {
    const { stdout } = await run('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch'], {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })

    let branch = ''
    let ahead = 0
    let behind = 0
    let dirty = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(line)
        ahead = Number(m?.[1] ?? 0)
        behind = Number(m?.[2] ?? 0)
      } else if (/^[12u?] /.test(line)) dirty++
    }
    if (branch) value = { branch: branch === '(detached)' ? 'detached' : branch, ahead, behind, dirty }
  } catch {
    // Not a repo, git missing, or the call timed out — all mean "no badge".
    value = null
  }

  gitCache.set(cwd, { at: Date.now(), value })
  return value
}

/**
 * Runnable tasks in a directory: package.json scripts and Makefile targets.
 *
 * Deliberately shallow — this is for the palette, not a build system. Makefile
 * targets are matched on the conventional `name:` at column zero, skipping pattern
 * rules and variables.
 */
export function listTasks(cwd: string): TaskEntry[] {
  if (!cwd) return []
  const out: TaskEntry[] = []

  try {
    const pkgPath = join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      const manager = existsSync(join(cwd, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(cwd, 'yarn.lock'))
          ? 'yarn'
          : 'npm'
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        out.push({
          name,
          detail: script.length > 60 ? `${script.slice(0, 57)}...` : script,
          command: manager === 'npm' ? `npm run ${name}` : `${manager} ${name}`,
          source: 'package.json',
        })
      }
    }
  } catch {
    /* malformed package.json is not worth surfacing here */
  }

  try {
    const mk = ['Makefile', 'makefile'].map((f) => join(cwd, f)).find((f) => existsSync(f))
    if (mk) {
      const seen = new Set<string>()
      for (const line of readFileSync(mk, 'utf8').split('\n')) {
        const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line)
        if (!m?.[1] || seen.has(m[1]) || m[1] === '.PHONY') continue
        seen.add(m[1])
        out.push({ name: m[1], detail: 'make target', command: `make ${m[1]}`, source: 'Makefile' })
      }
    }
  } catch {
    /* unreadable Makefile */
  }

  return out
}

/**
 * Free a TCP port by killing whatever is listening on it.
 *
 * Get-NetTCPConnection is the reliable way to map port -> owning pid on Windows;
 * netstat parsing breaks with IPv6 and localisation.
 */
export async function killPort(port: number): Promise<{ killed: number[]; error?: string }> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { killed: [], error: 'invalid port' }
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
      { timeout: 6000, windowsHide: true },
    )
    const pids = [...new Set(stdout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 4))]
    const killed: number[] = []
    for (const pid of pids) {
      try {
        process.kill(pid)
        killed.push(pid)
      } catch {
        /* already gone or not ours to kill */
      }
    }
    return { killed }
  } catch (err) {
    return { killed: [], error: (err as Error).message }
  }
}
