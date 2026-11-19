/**
 * Check todos: run `/check-todos` in the person's own Claude Code, headless, and hand back
 * what it said. It goes through what arrived since the last check (mail, Slack, Jira,
 * GitHub — whatever tools that Claude has), adds what the person must do to the todo list,
 * and ticks what has since been handled. It reads, adds and ticks; it never sends anything.
 *
 * Brought back 2026-11-19 (removed 2026-11-01 with the council and the map). With no
 * sources named the skill reads every one it has a tool for.
 *
 * Deliberately the person's own `claude`: their MCP servers and tools, their permissions,
 * on this machine. Ember adds a PATH that has `todo` on it and a clean environment.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import { NOTES_DIR } from './notes.js'
import { cleanEnv } from './pty/ConPtyHost.js'

/** When this machine last checked: the skill gets it as `since=…`, so a run reads only what is new. */
const TODO_STATE = join(CONFIG_DIR, 'todo-check.json')

export interface TodoState {
  lastCheckedAt?: string
}

export function todoState(): TodoState {
  try {
    return existsSync(TODO_STATE) ? (JSON.parse(readFileSync(TODO_STATE, 'utf8')) as TodoState) : {}
  } catch {
    return {}
  }
}

function saveTodoState(state: TodoState): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(TODO_STATE, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.error(`[ember] could not save the todo check state: ${(err as Error).message}`)
  }
}

type CheckResult = { ok: boolean; output: string; error?: string; lastCheckedAt?: string }
let running: Promise<CheckResult> | null = null

export function checkTodos(bin: string): Promise<{ ok: boolean; output: string; error?: string; lastCheckedAt?: string }> {
  if (running) return running
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), EMBER_NOTES_DIR: NOTES_DIR }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path'
  env[key] = [bin, env[key] ?? ''].filter(Boolean).join(';')
  const before = todoState()
  // The bookmark is the moment the run started: anything that lands while it reads is
  // caught next time rather than lost in the gap.
  const startedAt = new Date().toISOString()
  const args = before.lastCheckedAt ? [`since=${before.lastCheckedAt}`] : []
  const run = new Promise<CheckResult>((resolve) => {
    execFile(
      'claude',
      // One quoted argument: the shell would otherwise split the skill from its arguments.
      ['-p', `"${['/check-todos', ...args].join(' ')}"`, '--output-format', 'text', '--dangerously-skip-permissions'],
      { shell: true, cwd: homedir(), env, windowsHide: true, timeout: 8 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = String(stdout ?? '').trim()
        if (err && !output) return resolve({ ok: false, output: '', error: String(stderr || err.message).trim().slice(0, 400), lastCheckedAt: before.lastCheckedAt })
        saveTodoState({ lastCheckedAt: startedAt })
        resolve({ ok: true, output, lastCheckedAt: startedAt })
      }
    )
  }).finally(() => {
    running = null
  })
  running = run
  return run
}
