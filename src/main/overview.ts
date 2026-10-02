import { createReadStream, existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { eventsFrom, subscribe, transcriptFile, type Line, type TokenUsage, type TranscriptEvent } from './transcript.js'
import type { ActivityEntry, SessionBrief } from '../shared/types.js'

/**
 * One line per Claude session: what it last said, what it is doing now, and what it has
 * cost and changed so far — plus one log of everything every session did.
 *
 * The overview surface shows every session at once, and the thing worth a glance is
 * not the terminal's last screenful but the last sentence the model wrote and the tool
 * it is in the middle of. Both are in the session's transcript, which narration already
 * reads; this listens to the same feed for every bound tab and keeps the latest of each.
 *
 * A tab is tracked from the moment its session announces itself over the bridge — the
 * only moment tab id and session id are known together — and dropped with the tab. The
 * live watcher starts at the end of the file; what came before is read once, in the
 * background, for the totals (tokens, edits) and the last reply. That sentence carries
 * its own time, so a card showing it says "2h ago" rather than passing it off as news.
 */

const briefs = new Map<string, SessionBrief>()
const stops = new Map<string, () => void>()
const listeners = new Set<(b: SessionBrief) => void>()

/** What the brief is summed from, kept out of the brief so it never crosses IPC. */
interface Tally {
  /** message id -> its usage. Every content block repeats it, so a message is counted once. */
  usage: Map<string, TokenUsage>
  files: Set<string>
  /** Bumped when the tab is re-pointed at a new session, so a stale scan throws its result away. */
  epoch: number
}
const tallies = new Map<string, Tally>()

/** The log: every session's actions in one list, newest last. */
const LOG_MAX = 600
const log: ActivityEntry[] = []
const logListeners = new Set<(e: ActivityEntry[]) => void>()
let logPending: ActivityEntry[] = []
let logTimer: NodeJS.Timeout | null = null

/** The last sentence or two of what was said, short enough for one line. */
function lastSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= 160) return flat
  const parts = flat.split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
  let out = parts[parts.length - 1] ?? flat
  // A closing "Done." on its own says nothing; take the sentence before it too.
  for (let i = parts.length - 2; i >= 0 && out.length < 40; i--) out = `${parts[i]} ${out}`
  return out.length > 160 ? `…${out.slice(-158)}` : out
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/**
 * Lines in and out, the way a reviewer would count them: a line present on both sides
 * moved or stayed and is neither. Not a real diff — an edit's two strings are short and
 * this is a number on a card, not a patch.
 */
function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const pool = new Map<string, number>()
  for (const l of a) pool.set(l, (pool.get(l) ?? 0) + 1)
  let kept = 0
  for (const l of b) {
    const n = pool.get(l) ?? 0
    if (n > 0) {
      pool.set(l, n - 1)
      kept++
    }
  }
  return { added: b.length - kept, removed: a.length - kept }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** A tool call as one line of the log. */
function entryFor(tabId: string, at: number, tool: { name: string; input: Record<string, unknown> }): ActivityEntry {
  const { name, input } = tool
  const base = { tabId, at, added: 0, removed: 0 }
  const path = str(input['file_path']) || str(input['notebook_path']) || str(input['path'])
  switch (name) {
    case 'Edit': {
      const d = lineDelta(str(input['old_string']), str(input['new_string']))
      return { ...base, kind: 'edit', text: basename(path), detail: path, ...d }
    }
    case 'MultiEdit': {
      let added = 0
      let removed = 0
      for (const e of (input['edits'] as Array<Record<string, unknown>> | undefined) ?? []) {
        const d = lineDelta(str(e['old_string']), str(e['new_string']))
        added += d.added
        removed += d.removed
      }
      return { ...base, kind: 'edit', text: basename(path), detail: path, added, removed }
    }
    case 'NotebookEdit':
      return { ...base, kind: 'edit', text: basename(path), detail: path, ...lineDelta('', str(input['new_source'])) }
    case 'Write': {
      const content = str(input['content'])
      return { ...base, kind: 'write', text: basename(path), detail: path, added: content ? content.split('\n').length : 0 }
    }
    case 'Read':
      return { ...base, kind: 'read', text: basename(path), detail: path }
    case 'Grep':
    case 'Glob':
      return { ...base, kind: 'search', text: str(input['pattern']).slice(0, 80), detail: str(input['path']) }
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(input['command'])
      const said = str(input['description']) || cmd.split('\n')[0] || 'a command'
      return { ...base, kind: 'run', text: said.slice(0, 100), detail: cmd.slice(0, 400) }
    }
    case 'Task':
    case 'Agent':
      return { ...base, kind: 'agent', text: str(input['description']).slice(0, 90) || 'a subagent', detail: str(input['subagent_type']) }
    case 'WebFetch':
      return { ...base, kind: 'web', text: str(input['url']).replace(/^https?:\/\//, '').slice(0, 90), detail: str(input['url']) }
    case 'WebSearch':
      return { ...base, kind: 'web', text: str(input['query']).slice(0, 90), detail: '' }
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        return { ...base, kind: 'tool', text: [parts[1], parts[2]].filter(Boolean).join(' · '), detail: name }
      }
      return { ...base, kind: 'tool', text: name, detail: '' }
    }
  }
}

function emit(b: SessionBrief): void {
  for (const l of listeners) l(b)
}

function pushLog(entries: ActivityEntry[]): void {
  if (!entries.length) return
  log.push(...entries)
  // A backfill lands after live entries that are newer than it.
  log.sort((a, b) => a.at - b.at)
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX)
  logPending.push(...entries)
  // Batched: a session reading ten files in a second is one message to the renderer.
  if (logTimer) return
  logTimer = setTimeout(() => {
    logTimer = null
    const out = logPending
    logPending = []
    for (const l of logListeners) l(out)
  }, 250)
}

function addUsage(b: SessionBrief, t: Tally, id: string, u: TokenUsage): void {
  const old = t.usage.get(id)
  if (old) {
    b.tokens.input -= old.input
    b.tokens.output -= old.output
    b.tokens.cacheRead -= old.cacheRead
    b.tokens.cacheWrite -= old.cacheWrite
  }
  t.usage.set(id, u)
  b.tokens.input += u.input
  b.tokens.output += u.output
  b.tokens.cacheRead += u.cacheRead
  b.tokens.cacheWrite += u.cacheWrite
}

/** Fold one transcript event into a brief. Returns the log line it makes, if any. */
function apply(b: SessionBrief, t: Tally, e: Omit<TranscriptEvent, 'tabId'>, live: boolean): ActivityEntry | null {
  const at = live ? Date.now() : (e.at ?? b.startedAt)
  if (!b.startedAt && e.at) b.startedAt = e.at
  if (e.kind === 'usage') {
    if (e.msgId && e.usage) addUsage(b, t, e.msgId, e.usage)
    return null
  }
  if (e.kind === 'assistant') {
    if (at >= b.saidAt) {
      b.said = lastSentence(e.text)
      b.full = (e.full ?? e.text).slice(0, 8000)
      b.saidAt = at
    }
    if (live) b.turnEnded = false
    return null
  }
  if (e.kind === 'tool') {
    if (live) {
      b.doing = e.text
      b.doingAt = at
      b.turnEnded = false
    }
    if (!e.tool) return null
    const entry = entryFor(b.tabId, at, e.tool)
    if (entry.kind === 'edit' || entry.kind === 'write') {
      if (entry.detail) t.files.add(entry.detail.toLowerCase())
      b.edits.files = t.files.size
      b.edits.count++
      b.edits.added += entry.added
      b.edits.removed += entry.removed
    }
    return entry
  }
  if (e.kind === 'turn-end') {
    if (live) {
      b.turnEnded = true
      b.doing = ''
    }
    return { tabId: b.tabId, at, kind: 'done', text: 'finished its turn', detail: '', added: 0, removed: 0 }
  }
  return null
}

/**
 * Read what the session wrote before we were watching, once, without holding the main
 * process: a stream, and a cheap substring test before any JSON.parse, because most of a
 * transcript's bytes are tool results nobody here needs.
 */
async function backfill(tabId: string, file: string, end: number, epoch: number): Promise<void> {
  if (end <= 0) return
  const b = briefs.get(tabId)
  const t = tallies.get(tabId)
  if (!b || !t) return
  const recent: ActivityEntry[] = []
  try {
    const rl = createInterface({ input: createReadStream(file, { start: 0, end: end - 1 }), crlfDelay: Infinity })
    for await (const line of rl) {
      if (t.epoch !== epoch) {
        rl.close()
        return
      }
      if (!line.includes('"assistant"')) continue
      let parsed: Line
      try {
        parsed = JSON.parse(line) as Line
      } catch {
        continue
      }
      for (const e of eventsFrom(parsed)) {
        const entry = apply(b, t, e, false)
        if (!entry) continue
        recent.push(entry)
        // Only the tail goes into the log; the totals above still count all of it.
        if (recent.length > 80) recent.shift()
      }
    }
  } catch {
    return
  }
  if (t.epoch !== epoch || briefs.get(tabId) !== b) return
  b.at = Date.now()
  emit(b)
  pushLog(recent)
}

function freshBrief(tabId: string, sessionId: string, cwd: string): SessionBrief {
  return {
    tabId,
    sessionId,
    cwd,
    said: '',
    saidAt: 0,
    doing: '',
    doingAt: 0,
    turnEnded: false,
    at: Date.now(),
    full: '',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    edits: { files: 0, count: 0, added: 0, removed: 0 },
    startedAt: 0,
  }
}

function sizeOf(file: string): number {
  try {
    return existsSync(file) ? statSync(file).size : 0
  } catch {
    return 0
  }
}

/** Start (or re-point) the brief for a tab whose session has announced itself. */
export function trackBrief(tabId: string, sessionId: string, cwd: string): void {
  const existing = briefs.get(tabId)
  const tally = tallies.get(tabId)
  if (existing && tally) {
    if (existing.sessionId !== sessionId) {
      // A new `claude` in the same tab: what the old one said and spent is no longer news.
      tally.epoch++
      tally.usage.clear()
      tally.files.clear()
      Object.assign(existing, freshBrief(tabId, sessionId, cwd))
      emit(existing)
      const file = transcriptFile(sessionId, cwd)
      void backfill(tabId, file, sizeOf(file), tally.epoch)
    }
    return
  }
  const brief = freshBrief(tabId, sessionId, cwd)
  const fresh: Tally = { usage: new Map(), files: new Set(), epoch: 0 }
  briefs.set(tabId, brief)
  tallies.set(tabId, fresh)
  // Measured in the same tick the watcher seeks to the end, so the backlog and the live
  // tail meet at one offset and nothing is read twice or skipped.
  const file = transcriptFile(sessionId, cwd)
  const end = sizeOf(file)
  stops.set(
    tabId,
    subscribe(tabId, (e) => {
      const b = briefs.get(tabId)
      const t = tallies.get(tabId)
      if (!b || !t) return
      const entry = apply(b, t, e, true)
      b.at = Date.now()
      emit(b)
      if (entry) pushLog([entry])
    })
  )
  void backfill(tabId, file, end, fresh.epoch)
}

export function forgetBrief(tabId: string): void {
  stops.get(tabId)?.()
  stops.delete(tabId)
  briefs.delete(tabId)
  const t = tallies.get(tabId)
  if (t) t.epoch++
  tallies.delete(tabId)
}

export function allBriefs(): SessionBrief[] {
  return [...briefs.values()]
}

export function onBrief(fn: (b: SessionBrief) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function allActivity(): ActivityEntry[] {
  return [...log]
}

export function onActivity(fn: (e: ActivityEntry[]) => void): () => void {
  logListeners.add(fn)
  return () => logListeners.delete(fn)
}
