import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Reading agents other than Claude Code, for Loom.
 *
 * Loom's feed speaks one language: Claude Code's transcript. Every other agent that
 * writes a session log of its own gets an adapter here that finds that log and turns its
 * records into Claude-shaped lines — `{ type, uuid, timestamp, message: { content,
 * stop_reason } }` with `text`, `tool_use` and `tool_result` blocks — so Feed and
 * PhoneHost need not know which agent they are watching.
 *
 * Only formats seen on disk, or read in the CLI's own published code, are here. An agent
 * without an adapter still gets the canvas — its objects arrive through the canvas tools —
 * it just has no narration. Guessing at a format would be worse than that: a wrong guess
 * fails silently, or worse, half-renders.
 *
 * Tool names are mapped onto the ones Feed already knows (Bash, Edit, Write, Read, Grep,
 * WebSearch, TodoWrite, `mcp__<server>__<tool>`), so a Codex shell command folds and
 * shows like a Claude one, and a panel push through `ember-panel` anchors where it was made.
 */

export type Json = Record<string, unknown>

export interface AgentLog {
  /**
   * Newest session log for this folder written since `since` (ms), or null.
   * `taken` holds logs other tabs are already following, so two tabs in one folder do
   * not both settle on whichever session wrote last.
   */
  locate(cwd: string, since: number, taken?: ReadonlySet<string>): string | null
  /** 'jsonl' = appended lines (tail by offset); 'doc' = one JSON document rewritten whole. */
  kind: 'jsonl' | 'doc'
  /** Raw records → Claude-transcript-shaped lines (the canonical form Feed and PhoneHost read). */
  convert(records: Json[], state: Record<string, unknown>): Json[]
}

/** Slack on `since`: a log created in the same breath as the tab's agent mark still counts. */
const SINCE_SLACK = 5000

// ---------------------------------------------------------------- shared

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

/** A folder as a comparable key: absolute, forward slashes, no trailing slash, any case. */
export function sameDir(path: string): string {
  let p = String(path ?? '').trim()
  if (p.startsWith('file:///')) p = p.slice(8)
  try {
    p = resolve(p)
  } catch {
    /* keep as given */
  }
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The first line of a file, without reading the rest (Codex's first line alone can be 30KB). */
function firstLine(path: string, max = 512_000): string {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(max, 64_000))
    let text = ''
    let at = 0
    while (at < max) {
      const n = readSync(fd, buf, 0, buf.length, at)
      if (n <= 0) break
      const chunk = buf.toString('utf8', 0, n)
      const cut = chunk.indexOf('\n')
      if (cut !== -1) return text + chunk.slice(0, cut)
      text += chunk
      at += n
    }
    return text
  } catch {
    return ''
  } finally {
    if (fd !== -1) closeSync(fd)
  }
}

function line(type: 'user' | 'assistant', uuid: string, timestamp: string, content: Json[], stop?: string): Json {
  return {
    type,
    uuid,
    timestamp,
    message: { role: type, content, ...(stop ? { stop_reason: stop } : {}) },
  }
}

const userText = (uuid: string, at: string, text: string): Json => line('user', uuid, at, [{ type: 'text', text }])
const sayText = (uuid: string, at: string, text: string): Json => line('assistant', uuid, at, [{ type: 'text', text }])
const toolUse = (uuid: string, at: string, id: string, name: string, input: Json): Json =>
  line('assistant', uuid, at, [{ type: 'tool_use', id, name, input }])
const toolResult = (uuid: string, at: string, id: string, content: unknown, isError = false): Json =>
  line('user', uuid, at, [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }])
const turnEnd = (uuid: string, at: string): Json => line('assistant', uuid, at, [], 'end_turn')

/** A `*** Begin Patch` body, as the first file it touches and that file's before/after. */
function readPatch(patch: string): { name: 'Edit' | 'Write'; input: Json } {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  let file = ''
  let mode = ''
  let files = 0
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const l of lines) {
    const head = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(l)
    if (head) {
      files++
      if (files > 1) continue
      mode = head[1]!
      file = head[2]!.trim()
      continue
    }
    if (files !== 1 || l.startsWith('*** ')) continue
    if (l.startsWith('@@')) {
      if (oldLines.length || newLines.length) {
        oldLines.push('⋯')
        newLines.push('⋯')
      }
    } else if (l.startsWith('+')) newLines.push(l.slice(1))
    else if (l.startsWith('-')) oldLines.push(l.slice(1))
    else if (l.startsWith(' ')) {
      oldLines.push(l.slice(1))
      newLines.push(l.slice(1))
    }
  }
  const more = files > 1 ? `and ${files - 1} more file${files > 2 ? 's' : ''}` : undefined
  if (mode === 'Add') return { name: 'Write', input: { file_path: file, content: newLines.join('\n'), ...(more ? { description: more } : {}) } }
  return {
    name: 'Edit',
    input: { file_path: file, old_string: oldLines.join('\n'), new_string: newLines.join('\n'), ...(more ? { description: more } : {}) },
  }
}

/** MCP content blocks (text, image) as tool_result content Feed can read. */
function mcpContent(result: unknown): Json[] {
  const content = obj(result)['content']
  if (!Array.isArray(content)) return []
  const out: Json[] = []
  for (const c of content as Json[]) {
    if (c['type'] === 'text') out.push({ type: 'text', text: str(c['text']) })
    else if (c['type'] === 'image' && c['data'])
      out.push({ type: 'image', source: { type: 'base64', media_type: str(c['mimeType']) || 'image/png', data: str(c['data']) } })
  }
  return out
}

// ---------------------------------------------------------------- Codex

/**
 * Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl`, one record
 * per line, appended. Day folders are the local date the session started.
 *
 * Two generations of the format are on disk and both are read:
 *
 * - Older CLIs log the model's own calls: `function_call` `shell_command` with
 *   `{command, workdir}` and a `function_call_output` of `Exit code: N\nWall time…\nOutput:\n…`;
 *   `custom_tool_call` `apply_patch` with the patch text as `input`.
 * - Newer CLIs (0.15x, "code mode") have the model write JavaScript for one `exec` tool
 *   (polled with `wait`). The calls that script makes arrive as `event_msg` →
 *   `item_completed` items: `CommandExecution`, `McpToolCall {server, tool, arguments,
 *   result}`, `Extension` (web search). Those are what is shown; the script is not.
 *
 * Everything said is in `response_item` `message`s. The same words are echoed as
 * `event_msg` `user_message` / `agent_message` and `item_completed` UserMessage /
 * AgentMessage, which are skipped so nothing shows twice. `developer` messages and the
 * user-role blocks Codex injects (`<environment_context>`, `# AGENTS.md instructions`,
 * `<recommended_plugins>` …) are not the person speaking and are dropped.
 */

/** Codex's home: CODEX_HOME when set, as Codex itself reads it, else ~/.codex. */
const CODEX_HOME = process.env['CODEX_HOME'] || join(homedir(), '.codex')
const CODEX_SESSIONS = join(CODEX_HOME, 'sessions')
/** A whole message that is one injected tag block, or the AGENTS.md preamble. */
const CODEX_INJECTED = /^\s*(?:<([a-z_]+)>[\s\S]*<\/\1>\s*$|# AGENTS\.md instructions)/
/** The cwd in each rollout's first line, by path. A rollout's folder never changes. */
const codexCwd = new Map<string, string>()

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function codexLocate(cwd: string, since: number, taken?: ReadonlySet<string>): string | null {
  // No folder yet (an agent started as the shell's first command, before any prompt said
  // where it is): the newest session since the tab's agent started is the one.
  const want = cwd ? sameDir(cwd) : ''
  const floor = since - SINCE_SLACK
  // The folder is the day the session started, so today and yesterday cover any session
  // the tab could have started (a session running past midnight stays in yesterday's).
  const days = new Set<string>()
  for (const t of [Date.now(), Date.now() - 86_400_000, Math.min(Date.now(), Math.max(0, floor))]) {
    const d = new Date(t)
    days.add(join(CODEX_SESSIONS, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
  }
  let best: string | null = null
  let bestAt = 0
  for (const dir of days) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue
      const path = join(dir, n)
      if (taken?.has(path)) continue
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (mtime < floor || mtime <= bestAt) continue
      let dirOf = codexCwd.get(path)
      if (dirOf === undefined) {
        try {
          const meta = JSON.parse(firstLine(path)) as Json
          const payload = obj(meta['payload'])
          // Headless runs (the council, Ember's own questions) are `codex exec`; a tab only
          // ever follows an interactive session.
          const headless = str(payload['originator']) === 'codex_exec' || str(payload['source']) === 'exec'
          dirOf = meta['type'] === 'session_meta' && !headless ? sameDir(str(payload['cwd'])) : '<headless>'
        } catch {
          // The first line is still being written; try again next time.
          continue
        }
        codexCwd.set(path, dirOf)
      }
      if (dirOf === '<headless>') continue
      if (want && dirOf !== want) continue
      best = path
      bestAt = mtime
    }
  }
  return best
}

/** `Exit code: N\nWall time: …\nOutput:\n…` → the output and whether it failed. */
function codexShellOutput(raw: string): { text: string; failed: boolean } {
  const m = /^Exit code: (-?\d+)\r?\n(?:Wall time:[^\n]*\n)?(?:Output:\r?\n)?/.exec(raw)
  if (!m) return { text: raw, failed: false }
  return { text: raw.slice(m[0].length), failed: Number(m[1]) !== 0 }
}

/** A tool output that is a string, or an array of `input_text` parts. */
function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return (output as Json[]).map((p) => str(p['text'])).join('\n')
  return ''
}

function codexUserContent(content: unknown): Json[] {
  if (!Array.isArray(content)) return []
  const out: Json[] = []
  for (const part of content as Json[]) {
    if (part['type'] === 'input_text') {
      const text = str(part['text'])
      if (!text.trim() || CODEX_INJECTED.test(text)) continue
      out.push({ type: 'text', text })
    } else if (part['type'] === 'input_image') {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(str(part['image_url']))
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
  }
  return out
}

function codexConvert(records: Json[], state: Record<string, unknown>): Json[] {
  const out: Json[] = []
  // Which calls were apply_patch, shell or the code-mode script: their outputs read differently.
  const calls = (state['calls'] ??= new Map<string, string>()) as Map<string, string>
  for (const r of records) {
    const n = ((state['n'] as number | undefined) ?? 0) + 1
    state['n'] = n
    const at = str(r['timestamp'])
    const p = obj(r['payload'])
    const key = `cx-${typeof r['ordinal'] === 'number' ? r['ordinal'] : n}`
    const ptype = str(p['type'])

    if (r['type'] === 'compacted') {
      out.push({ type: 'system', subtype: 'compact_boundary', uuid: key, timestamp: at })
      continue
    }

    if (r['type'] === 'response_item') {
      const id = str(p['id']) || key
      if (ptype === 'message') {
        const role = str(p['role'])
        if (role === 'user') {
          const content = codexUserContent(p['content'])
          if (content.length) out.push(line('user', id, at, content))
        } else if (role === 'assistant') {
          const text = (Array.isArray(p['content']) ? (p['content'] as Json[]) : [])
            .filter((c) => c['type'] === 'output_text')
            .map((c) => str(c['text']))
            .join('')
          if (text.trim()) out.push(sayText(id, at, text))
        }
        continue
      }
      if (ptype === 'reasoning') {
        const summary = (Array.isArray(p['summary']) ? (p['summary'] as Json[]) : []).map((s) => str(s['text'])).join('\n\n')
        if (summary.trim()) out.push(line('assistant', id, at, [{ type: 'thinking', thinking: summary }]))
        continue
      }
      if (ptype === 'function_call') {
        const name = str(p['name'])
        const callId = str(p['call_id']) || id
        calls.set(callId, name)
        // `wait` polls a running code-mode script: its calls show up as items instead.
        if (name === 'wait') continue
        let args: Json = {}
        try {
          args = obj(JSON.parse(str(p['arguments']) || '{}'))
        } catch {
          args = { arguments: str(p['arguments']) }
        }
        if (name === 'shell_command' || name === 'shell') {
          const cmd = args['command']
          const command = Array.isArray(cmd) ? (cmd as unknown[]).map(String).join(' ') : str(cmd)
          out.push(toolUse(id, at, callId, 'Bash', { command }))
        } else out.push(toolUse(id, at, callId, name, args))
        continue
      }
      if (ptype === 'function_call_output') {
        const callId = str(p['call_id'])
        const name = calls.get(callId) ?? ''
        if (name === 'wait') continue
        const raw = codexOutputText(p['output'])
        if (name === 'shell_command' || name === 'shell') {
          const { text, failed } = codexShellOutput(raw)
          out.push(toolResult(id, at, callId, text, failed))
        } else out.push(toolResult(id, at, callId, raw))
        continue
      }
      if (ptype === 'custom_tool_call') {
        const name = str(p['name'])
        const callId = str(p['call_id']) || id
        calls.set(callId, name)
        if (name === 'exec') continue
        if (name === 'apply_patch') {
          const patch = readPatch(str(p['input']))
          out.push(toolUse(id, at, callId, patch.name, patch.input))
        } else out.push(toolUse(id, at, callId, name, { input: str(p['input']) }))
        continue
      }
      if (ptype === 'custom_tool_call_output') {
        const callId = str(p['call_id'])
        const name = calls.get(callId) ?? ''
        if (name === 'exec') continue
        const raw = codexOutputText(p['output'])
        if (name === 'apply_patch') {
          // Success is JSON `{output, metadata: {exit_code}}`; a refusal is a bare sentence.
          try {
            const j = obj(JSON.parse(raw))
            out.push(toolResult(id, at, callId, str(j['output']), Number(obj(j['metadata'])['exit_code'] ?? 0) !== 0))
          } catch {
            out.push(toolResult(id, at, callId, raw, true))
          }
        } else out.push(toolResult(id, at, callId, raw))
        continue
      }
      if (ptype === 'web_search_call') {
        const action = obj(p['action'])
        const queries = Array.isArray(action['queries']) ? (action['queries'] as unknown[]).map(String) : []
        const query = str(action['query']) || queries.join(' · ')
        out.push(toolUse(id, at, id, 'WebSearch', { query }))
        out.push(toolResult(`${id}:result`, at, id, ''))
        continue
      }
      continue
    }

    if (r['type'] === 'event_msg') {
      if (ptype === 'task_complete') {
        const turn = str(p['turn_id']) || key
        // A turn can end on an error with nothing said (an expired sign-in, say): show why.
        const error = str(obj(p['error'])['message'])
        if (error) out.push({ type: 'system', subtype: 'error', uuid: `${turn}:error`, timestamp: at, content: error })
        out.push(turnEnd(`${turn}:end`, at))
        continue
      }
      if (ptype === 'turn_aborted') {
        const turn = str(p['turn_id']) || key
        out.push(userText(`${turn}:aborted`, at, '[Request interrupted by user]'))
        out.push(turnEnd(`${turn}:end`, at))
        continue
      }
      if (ptype !== 'item_completed') continue
      const item = obj(p['item'])
      const itemId = str(item['id']) || key
      const kind = str(item['type'])
      if (kind === 'CommandExecution') {
        const cmd = Array.isArray(item['command']) ? (item['command'] as unknown[]).map(String) : []
        // `[shell.exe, -Command, <what the model wrote>]`; the parsed form has it plainly too.
        const parsed = Array.isArray(item['parsed_cmd']) ? (item['parsed_cmd'] as Json[]) : []
        const command = cmd.length >= 3 ? cmd[cmd.length - 1]! : str(parsed[0]?.['cmd']) || cmd.join(' ')
        out.push(toolUse(itemId, at, itemId, 'Bash', { command }))
        const text = str(item['aggregated_output']) || str(item['formatted_output']) || `${str(item['stdout'])}${str(item['stderr'])}`
        const code = item['exit_code']
        out.push(toolResult(`${itemId}:result`, at, itemId, text, (typeof code === 'number' && code !== 0) || item['status'] === 'failed'))
      } else if (kind === 'McpToolCall') {
        const name = `mcp__${str(item['server'])}__${str(item['tool'])}`
        out.push(toolUse(itemId, at, itemId, name, obj(item['arguments'])))
        const failed = item['status'] === 'failed'
        const content = failed ? str(obj(item['error'])['message']) || 'failed' : mcpContent(item['result'])
        out.push(toolResult(`${itemId}:result`, at, itemId, content, failed))
      } else if (kind === 'Extension' && str(item['kind']) === 'web.search') {
        out.push(toolUse(itemId, at, itemId, 'WebSearch', { query: str(item['query']) }))
        const results = Array.isArray(item['results']) ? (item['results'] as Json[]) : []
        const text = results.map((x) => `${str(x['title'])} — ${str(x['url'])}`).join('\n')
        out.push(toolResult(`${itemId}:result`, at, itemId, text))
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- Gemini CLI

/**
 * Gemini CLI (read from @google/gemini-cli-core 0.66, `services/chatRecordingService`;
 * no session of it has been run on this machine). Each project gets a folder under
 * `~/.gemini/tmp/<slug>/` holding a `.project_root` file with the project's path; its
 * sessions are `chats/session-<YYYY-MM-DDTHH-mm>-<id8>.jsonl`.
 *
 * The file is appended, but not one record per event: a message is written whole each
 * time it changes (same `id`, the last one wins) — first its text, again when its tool
 * calls are added, again as their results arrive. Alongside are `$set` (metadata),
 * `$patch` (history edits, tool results) and `$rewindTo` records. So lines here get uuids
 * per piece — the text, each call, each result — and Feed's uuid dedupe lets a rewritten
 * message add only what is new.
 *
 * Gemini records no end-of-turn marker, so no line here carries `end_turn`.
 */

const GEMINI_TMP = join(homedir(), '.gemini', 'tmp')
const geminiRoots = new Map<string, string>()

function geminiLocate(cwd: string, since: number, taken?: ReadonlySet<string>): string | null {
  const want = sameDir(cwd)
  const floor = since - SINCE_SLACK
  let slugs: string[] = []
  try {
    slugs = readdirSync(GEMINI_TMP)
  } catch {
    return null
  }
  let best: string | null = null
  let bestAt = 0
  for (const slug of slugs) {
    const dir = join(GEMINI_TMP, slug)
    let root = geminiRoots.get(dir)
    if (root === undefined) {
      const marker = join(dir, '.project_root')
      if (!existsSync(marker)) continue
      try {
        root = sameDir(readFileSync(marker, 'utf8'))
      } catch {
        continue
      }
      geminiRoots.set(dir, root)
    }
    if (root !== want) continue
    const chats = join(dir, 'chats')
    let names: string[] = []
    try {
      names = readdirSync(chats)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.startsWith('session-') || !n.endsWith('.jsonl')) continue
      const path = join(chats, n)
      if (taken?.has(path)) continue
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (mtime < floor || mtime <= bestAt) continue
      best = path
      bestAt = mtime
    }
  }
  return best
}

/** Gemini's own tool names and arguments, as the Claude tools Feed draws. */
function geminiTool(name: string, args: Json): { name: string; input: Json } {
  switch (name) {
    case 'run_shell_command':
      return { name: 'Bash', input: { command: str(args['command']), ...(args['description'] ? { description: str(args['description']) } : {}) } }
    case 'replace':
      return { name: 'Edit', input: { file_path: str(args['file_path']), old_string: str(args['old_string']), new_string: str(args['new_string']) } }
    case 'write_file':
      return { name: 'Write', input: { file_path: str(args['file_path']), content: str(args['content']) } }
    case 'read_file':
      return { name: 'Read', input: { file_path: str(args['file_path']) } }
    case 'read_many_files':
      return { name: 'Read', input: { file_path: Array.isArray(args['include']) ? (args['include'] as unknown[]).join(', ') : str(args['include']) } }
    case 'glob':
      return { name: 'Glob', input: { pattern: str(args['pattern']) } }
    case 'grep_search':
      return { name: 'Grep', input: { pattern: str(args['pattern']) } }
    case 'list_directory':
      return { name: 'LS', input: { path: str(args['dir_path']) } }
    case 'google_web_search':
      return { name: 'WebSearch', input: { query: str(args['query']) } }
    case 'web_fetch':
      return { name: 'WebFetch', input: { prompt: str(args['prompt']) } }
    case 'write_todos': {
      const todos = Array.isArray(args['todos']) ? (args['todos'] as Json[]) : []
      return {
        name: 'TodoWrite',
        input: { todos: todos.map((t) => ({ content: str(t['description']), activeForm: str(t['description']), status: str(t['status']) })) },
      }
    }
  }
  // MCP tools are `mcp_<server>_<tool>` (generateValidName). A server with `_` in its name
  // splits wrong here, but only its label suffers; `ember-panel` has none.
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name)
  if (mcp) return { name: `mcp__${mcp[1]}__${mcp[2]}`, input: args }
  return { name, input: args }
}

/** A PartListUnion (string, a Part, or Parts) as plain text; thought parts left out. */
function geminiText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts = Array.isArray(content) ? (content as unknown[]) : content ? [content] : []
  return parts
    .map((p) => (typeof p === 'string' ? p : obj(p)['thought'] === true ? '' : str(obj(p)['text'])))
    .join('')
}

/** A tool's recorded result: functionResponse parts carry `{output}` or `{error}`. */
function geminiResult(result: unknown, display: unknown): { text: string; error: boolean } {
  const parts = Array.isArray(result) ? (result as unknown[]) : result ? [result] : []
  const texts: string[] = []
  let error = false
  for (const raw of parts) {
    const p = obj(raw)
    const fr = obj(p['functionResponse'])
    if (Object.keys(fr).length) {
      const resp = obj(fr['response'])
      if (resp['error'] !== undefined) {
        error = true
        texts.push(typeof resp['error'] === 'string' ? resp['error'] : JSON.stringify(resp['error']))
      } else if (resp['output'] !== undefined) texts.push(typeof resp['output'] === 'string' ? resp['output'] : JSON.stringify(resp['output']))
    } else if (typeof raw === 'string') texts.push(raw)
    else if (p['text']) texts.push(str(p['text']))
  }
  const text = texts.join('\n')
  return { text: text || (typeof display === 'string' ? display : ''), error }
}

function geminiCalls(msgId: string, at: string, calls: unknown, out: Json[]): void {
  if (!Array.isArray(calls)) return
  for (const raw of calls as Json[]) {
    const id = str(raw['id'])
    if (!id) continue
    const at2 = str(raw['timestamp']) || at
    const tool = geminiTool(str(raw['name']), obj(raw['args']))
    out.push(toolUse(`${msgId}:${id}`, at2, id, tool.name, tool.input))
    const status = str(raw['status'])
    if (status === 'success' || status === 'error' || status === 'cancelled' || (raw['result'] != null && status === '')) {
      const r = geminiResult(raw['result'], raw['resultDisplay'])
      out.push(toolResult(`${msgId}:${id}:result`, at2, id, status === 'cancelled' && !r.text ? 'cancelled' : r.text, r.error || status === 'error'))
    }
  }
}

function geminiConvert(records: Json[]): Json[] {
  const out: Json[] = []
  const message = (m: Json): void => {
    const id = str(m['id'])
    const at = str(m['timestamp'])
    const type = str(m['type'])
    if (type === 'user') {
      // `displayContent` is what the person typed; `content` has @file expansions inlined.
      const text = geminiText(m['displayContent'] ?? m['content'])
      if (text.trim()) out.push(userText(id, at, text))
    } else if (type === 'gemini') {
      const thoughts = Array.isArray(m['thoughts']) ? (m['thoughts'] as Json[]) : []
      if (thoughts.length) {
        const thinking = thoughts.map((t) => `${str(t['subject'])}${t['description'] ? `: ${str(t['description'])}` : ''}`).join('\n')
        out.push(line('assistant', `${id}:thought`, at, [{ type: 'thinking', thinking }]))
      }
      const text = geminiText(m['content'])
      if (text.trim()) out.push(sayText(`${id}:text`, at, text))
      geminiCalls(id, at, m['toolCalls'], out)
    } else if (type === 'info' || type === 'error' || type === 'warning') {
      const text = geminiText(m['content'])
      if (text.trim()) out.push({ type: 'system', subtype: type, uuid: id, timestamp: at, content: text })
    }
  }
  for (const r of records) {
    if (typeof r['id'] === 'string' && !('$patch' in r)) {
      message(r)
      continue
    }
    const set = obj(r['$set'])
    // A legacy full-history checkpoint.
    if (Array.isArray(set['messages'])) for (const m of set['messages'] as Json[]) message(m)
    const patch = obj(r['$patch'])
    const updates = [...(typeof patch['id'] === 'string' ? [patch] : []), ...(Array.isArray(patch['updates']) ? (patch['updates'] as Json[]) : [])]
    for (const u of updates) {
      const msgId = str(u['id'])
      for (const tc of Array.isArray(u['toolCalls']) ? (u['toolCalls'] as Json[]) : []) {
        if (tc['result'] == null) continue
        const r2 = geminiResult(tc['result'], undefined)
        out.push(toolResult(`${msgId}:${str(tc['id'])}:result`, '', str(tc['id']), r2.text, r2.error))
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- registry

/**
 * Keyed by the agent ids in shared/agents.ts. Not here, and why:
 * - qwen: a Gemini CLI fork, but its recorder has diverged and nothing of it is on this
 *   machine to check against.
 * - opencode, copilot, cursor: no session files on this machine (`~/.local/share/opencode`,
 *   `~/.copilot` absent; `~/.cursor` holds only cli-config.json), so their formats are
 *   unverified.
 */
export const AGENT_LOGS: Record<string, AgentLog> = {
  codex: { kind: 'jsonl', locate: codexLocate, convert: codexConvert },
  gemini: { kind: 'jsonl', locate: geminiLocate, convert: (records) => geminiConvert(records) },
}
