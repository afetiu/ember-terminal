import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { MapLiveSession } from '../shared/types.js'
import { tabForSession } from './transcript.js'

/**
 * Where Claude is working right now, for the map.
 *
 * Every Claude Code session on this machine — in an Ember tab, a remote-control session
 * from the phone, a plain terminal — writes its transcript to
 * `~/.claude/projects/<slug>/<session>.jsonl` as it goes. Each tool call in it names the
 * file it touched. That is the whole mechanism: tail the transcripts that moved recently,
 * keep the last half hour of paths per session, and let the map match paths to parts.
 * Nothing is guessed from what a session *says*; only from what it opened and changed.
 *
 * The map's own headless runs read half the machine while surveying. They are started
 * with a known session id and left out, or the map would light up with its own shadow.
 */

const PROJECTS = join(homedir(), '.claude', 'projects')
/** A transcript untouched for this long is not a session anyone is running. */
const FRESH_MS = 45 * 60_000
/** Touches older than this are dropped: the map shows where work is, not where it was. */
const KEEP_MS = 30 * 60_000
/** On first sight of a transcript, read only its tail. */
const FIRST_READ = 256 * 1024

const ignored = new Set<string>()

/** The map's own `claude -p` runs: never shown as someone working. */
export function ignoreSession(id: string): void {
  ignored.add(id)
}

interface Tail {
  offset: number
  partial: string
  session: MapLiveSession
}

const tails = new Map<string, Tail>()

function pathsOf(name: string, input: Record<string, unknown>, cwd: string): Array<{ path: string; mode: 'edit' | 'read' }> {
  const abs = (p: unknown): string | null => {
    if (typeof p !== 'string' || !p) return null
    const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p.replace(/^\/([a-z])\//i, '$1:/')
    return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded))
  }
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = abs(input['file_path'] ?? input['notebook_path'])
      return p ? [{ path: p, mode: 'edit' }] : []
    }
    case 'Read':
    case 'Grep':
    case 'Glob': {
      const p = abs(input['file_path'] ?? input['path'])
      return p ? [{ path: p, mode: 'read' }] : []
    }
    default:
      return []
  }
}

function readNew(file: string, t: Tail): void {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return
  }
  if (size < t.offset) {
    t.offset = 0
    t.partial = ''
  }
  if (size === t.offset) return
  const fd = openSync(file, 'r')
  try {
    const len = Math.min(size - t.offset, 4 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, t.offset)
    t.offset += len
    const text = t.partial + buf.toString('utf8')
    const lines = text.split('\n')
    t.partial = lines.pop() ?? ''
    for (const line of lines) digest(line, t.session)
  } finally {
    closeSync(fd)
  }
}

function digest(line: string, s: MapLiveSession): void {
  if (!line.includes('"assistant"')) return
  let ev: Record<string, unknown>
  try {
    ev = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (ev['type'] !== 'assistant') return
  const at = Date.parse(String(ev['timestamp'] ?? '')) || Date.now()
  if (typeof ev['cwd'] === 'string') s.cwd = ev['cwd']
  s.lastAt = Math.max(s.lastAt, at)
  const content = ((ev['message'] as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>
  for (const c of content) {
    if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].trim()) {
      s.lastText = c['text'].trim().replace(/\s+/g, ' ').slice(0, 220)
    } else if (c['type'] === 'tool_use') {
      const input = (c['input'] as Record<string, unknown>) ?? {}
      for (const p of pathsOf(String(c['name']), input, s.cwd)) s.touches.push({ ...p, at })
      if (c['name'] === 'Bash' && /\bgit\b[^|;&]*\bcommit\b/.test(String(input['command'] ?? ''))) {
        s.touches.push({ path: resolve(s.cwd), mode: 'commit', at })
      }
    }
  }
}

function scan(): MapLiveSession[] {
  const now = Date.now()
  const out: MapLiveSession[] = []
  if (!existsSync(PROJECTS)) return out
  for (const dir of readdirSync(PROJECTS)) {
    const full = join(PROJECTS, dir)
    let files: string[]
    try {
      files = readdirSync(full).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const file = join(full, f)
      const id = basename(f, '.jsonl')
      if (ignored.has(id)) continue
      let mtime: number
      let size: number
      try {
        const st = statSync(file)
        mtime = st.mtimeMs
        size = st.size
      } catch {
        continue
      }
      if (now - mtime > FRESH_MS) {
        tails.delete(file)
        continue
      }
      let t = tails.get(file)
      if (!t) {
        t = {
          offset: Math.max(0, size - FIRST_READ),
          partial: '',
          session: { sessionId: id, cwd: '', lastAt: 0, lastText: '', touches: [] },
        }
        // Starting mid-file lands mid-line; the first fragment is thrown away.
        if (t.offset > 0) t.partial = '\u0000'
        tails.set(file, t)
      }
      readNew(file, t)
      if (t.partial.startsWith('\u0000')) t.partial = ''
      const s = t.session
      s.touches = s.touches.filter((x) => now - x.at < KEEP_MS).slice(-300)
      const tab = tabForSession(id)
      if (tab) s.tabId = tab
      else delete s.tabId
      if (s.lastAt && now - s.lastAt < FRESH_MS) out.push({ ...s, touches: [...s.touches] })
    }
  }
  return out.sort((a, b) => b.lastAt - a.lastAt)
}

/** Report every few seconds while anyone is looking. Returns the stop. */
export function startLive(send: (sessions: MapLiveSession[]) => void): () => void {
  let last = ''
  const tick = () => {
    try {
      const sessions = scan()
      const key = JSON.stringify(sessions.map((s) => [s.sessionId, s.lastAt, s.touches.length, s.tabId]))
      if (key !== last) {
        last = key
        send(sessions)
      }
    } catch (e) {
      console.error(`[ember] map live scan: ${(e as Error).message}`)
    }
  }
  tick()
  const iv = setInterval(tick, 3000)
  return () => clearInterval(iv)
}
