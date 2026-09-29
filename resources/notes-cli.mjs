#!/usr/bin/env node
/**
 * `notes` — the notes folder, from any shell.
 *
 * Ember's notes are ordinary .md files in one folder (see src/main/notes.ts). This is
 * the command-line face of that folder, and it is a command rather than an MCP tool on
 * purpose: a tool costs context in every session whether or not it is used, and only
 * exists inside an Ember tab. A command costs nothing until it is run, and runs from
 * anywhere — a Windows Terminal, a phone session, a script — because the folder is the
 * same folder wherever you stand.
 *
 * Ember writes launchers for this file into ~/.ember/bin and puts that on the PATH of
 * every shell it opens (`notes` and `note`, for sh and for cmd/PowerShell). To use it
 * outside Ember, put ~/.ember/bin on your PATH.
 *
 * Runs under Ember's own binary as node (ELECTRON_RUN_AS_NODE), so there is nothing to
 * install and no dependency to resolve. Everything here is the standard library.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const DIR = process.env.EMBER_NOTES_DIR || join(homedir(), 'Documents', 'Ember Notes')
const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID
const EXT = '.md'

const HELP = `notes — your notes, as files. ${DIR}

  notes                        open the Notes tab (inside Ember; elsewhere, lists them)
  notes list [--json]          every note, newest first
  notes read <note>            print one
  notes new [--open] [text…]   create one; the text is its first line, which is the title
  notes write <note> [text…]   replace its content (text, or stdin)
  notes append <note> [text…]  add to the end (text, or stdin)
  notes delete <note>          to the recycle bin
  notes open [note]            show it in an Ember tab
  notes dir                    print the folder
  note [text…]                 = notes new --open

<note> is the file name (with or without .md) or a unique part of the title.
The first line of a note is its title and its file name; change one and you change both.

  todo                         open the Todo list (a note whose lines are items)
  todo add <text…>             add an item
  todo done <words…>           tick the first open item that contains the words
  todo list [--all]            print the open items (--all: ticked and archived ones too)
  todo clear done              move the ticked items to the archive, dated today
  todo archive                 print the archive, newest day first
  todo sources [names…]        where Check todos looks on this machine; names set it
  todo check [sources…]        run /check-todos in Claude: mail, Slack, Jira, GitHub → the
                               list, and ticks what is done (sources: gmail outlook slack
                               jira github; default from Settings › Todo)`

// ---------------------------------------------------------------- the folder

const UNSAFE = /[<>:"/\\|?* -]/g

function titleOf(body) {
  for (const line of body.split(/\r?\n/, 40)) {
    const t = line.replace(/^#{1,6}\s*/, '').trim()
    if (t) return t.slice(0, 120)
  }
  return ''
}

/** Same derivation as Ember's, so a note made here is named the way the tab names it. */
function fileNameFor(title, at = new Date()) {
  const slug = title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '')
  if (slug) return `${slug}${EXT}`
  const p = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}${EXT}`
}

function unique(name) {
  if (!existsSync(join(DIR, name))) return name
  const stem = name.slice(0, -EXT.length)
  for (let n = 2; n < 500; n++) {
    const candidate = `${stem} (${n})${EXT}`
    if (!existsSync(join(DIR, candidate))) return candidate
  }
  return `${stem} ${Date.now()}${EXT}`
}

function list() {
  mkdirSync(DIR, { recursive: true })
  return readdirSync(DIR)
    .filter((f) => /\.(md|txt)$/i.test(f))
    // The todo list and its archive are their own thing, not notes.
    .filter((f) => f.toLowerCase() !== 'todo.md' && f.toLowerCase() !== 'todo.archive.md')
    .map((f) => {
      try {
        const st = statSync(join(DIR, f))
        if (!st.isFile()) return null
        const body = readFileSync(join(DIR, f), 'utf8')
        const title = titleOf(body)
        const rest = body.slice(body.indexOf(title) + title.length)
        return {
          id: f,
          title: title || f.replace(/\.(md|txt)$/i, ''),
          preview: rest.replace(/\s+/g, ' ').trim().slice(0, 120),
          modified: st.mtimeMs,
          bytes: st.size,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
}

/** The file name for an id, a bare stem, or a unique piece of a title. */
function resolve(ref) {
  if (!ref) fail('which note? give a file name or part of its title')
  if (ref.includes('/') || ref.includes('\\') || ref.includes('..')) fail('a note is a file in the notes folder, not a path')
  // The file system answers case-insensitively; the directory listing has the real name.
  const entries = existsSync(DIR) ? readdirSync(DIR) : []
  for (const candidate of [ref, `${ref}${EXT}`, `${ref}.txt`]) {
    const real = entries.find((e) => e.toLowerCase() === candidate.toLowerCase())
    if (real && statSync(join(DIR, real)).isFile()) return real
  }
  const q = ref.toLowerCase()
  const all = list()
  const exact = all.filter((n) => n.title.toLowerCase() === q)
  if (exact.length === 1) return exact[0].id
  const hits = all.filter((n) => n.title.toLowerCase().includes(q))
  if (hits.length === 1) return hits[0].id
  if (hits.length === 0) fail(`no note matches "${ref}"`)
  fail(`"${ref}" matches ${hits.length} notes:\n` + hits.map((n) => `  ${n.id}`).join('\n'))
}

function read(id) {
  return readFileSync(join(DIR, id), 'utf8')
}

/** Write, and follow the title if it changed — the same rule the tab applies. */
function save(id, body) {
  writeFileSync(join(DIR, id), body, 'utf8')
  const wanted = fileNameFor(titleOf(body))
  if (wanted === id || existsSync(join(DIR, wanted))) return id
  try {
    renameSync(join(DIR, id), join(DIR, wanted))
    return wanted
  } catch {
    return id
  }
}

function create(body) {
  mkdirSync(DIR, { recursive: true })
  const name = unique(fileNameFor(titleOf(body)))
  writeFileSync(join(DIR, name), body, 'utf8')
  return name
}

function recycle(id) {
  // The recycle bin is a shell concept, and .NET is the shortest route to it from a
  // node process that is not Electron's main.
  const full = join(DIR, id)
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${full.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      ],
      { windowsHide: true, timeout: 15_000 },
    )
    if (ps.status === 0) return true
  }
  return false
}

// ---------------------------------------------------------------- Ember, when there is one

async function bridge(path, body) {
  if (!BRIDGE || !TOKEN) return false
  try {
    const res = await fetch(`${BRIDGE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
      body: JSON.stringify({ ...body, tabId: TAB }),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- the command

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

function readStdin() {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function when(ms) {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  return new Date(ms).toISOString().slice(0, 10)
}

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const args = argv.filter((a) => !a.startsWith('--'))
const [verb, ...rest] = args

// ---- the todo list: one note, `Todo.md`, whose lines are `- [ ] item` ----------------
const TODO = 'Todo.md'

function todoBody() {
  mkdirSync(DIR, { recursive: true })
  const full = join(DIR, TODO)
  if (!existsSync(full)) writeFileSync(full, '', 'utf8')
  return readFileSync(full, 'utf8')
}

/**
 * Where ticked items go when the list is cleared: `## YYYY-MM-DD` per day, newest day
 * first, the same lines as the list. Kept beside it so `todo list --all` — what the
 * checker reads before adding anything — still sees a thing that was done and archived.
 */
const ARCHIVE = 'Todo.archive.md'

function archiveBody() {
  const full = join(DIR, ARCHIVE)
  return existsSync(full) ? readFileSync(full, 'utf8') : ''
}

/** The archived items, newest first, as `[x] text`. */
function archivedItems() {
  return archiveBody()
    .split('\n')
    .filter((l) => /^\s*- \[[xX]\] /.test(l))
    .map((l) => `[x] ${l.replace(/^\s*- \[[xX]\] /, '')}`)
}

/** Put items under today's heading, adding the heading if the top one is another day. */
function archiveAdd(items) {
  const today = new Date().toISOString().slice(0, 10)
  const body = archiveBody().replace(/^\s+/, '')
  const lines = items.map((t) => `- [x] ${t}`)
  const next = body.startsWith(`## ${today}\n`)
    ? `## ${today}\n${lines.join('\n')}\n${body.slice(`## ${today}\n`.length)}`
    : `## ${today}\n${lines.join('\n')}\n${body ? `\n${body}` : ''}`
  writeFileSync(join(DIR, ARCHIVE), next, 'utf8')
}

async function todo(sub, words) {
  switch (sub) {
    case undefined:
    case 'open': {
      todoBody()
      if (await bridge('/notes/open', { mode: 'todo' })) return
      // No Ember to show it in: print it instead.
      return todo('list', [])
    }
    case 'add': {
      const text = words.join(' ').trim() || readStdin().trim()
      if (!text) fail('todo add: what?')
      const body = todoBody()
      const sep = body.endsWith('\n') || body.length === 0 ? '' : '\n'
      writeFileSync(join(DIR, TODO), `${body}${sep}- [ ] ${text}\n`, 'utf8')
      console.log(`added: ${text}`)
      return
    }
    case 'done': {
      const q = words.join(' ').trim().toLowerCase()
      if (!q) fail('todo done: which one? give a few words of it')
      const lines = todoBody().split('\n')
      const i = lines.findIndex((l) => /^\s*- \[ \] /.test(l) && l.toLowerCase().includes(q))
      if (i === -1) fail(`no open item contains "${q}"`)
      lines[i] = lines[i].replace('- [ ] ', '- [x] ')
      writeFileSync(join(DIR, TODO), lines.join('\n'), 'utf8')
      console.log(`done: ${lines[i].replace(/^\s*- \[x\] /, '')}`)
      return
    }
    case 'check': {
      const SOURCES = ['gmail', 'outlook', 'slack', 'jira', 'github']
      // The person's own Claude, in this shell, with its output showing. `todo` is on
      // this PATH already if this is an Ember shell; the skill knows the fallback if not.
      // Which sources to read is this machine's setting (Settings › Todo); words after
      // `check` override it: `todo check gmail`.
      let sources = words.map((w) => w.toLowerCase()).filter((w) => SOURCES.includes(w))
      if (!sources.length) {
        try {
          const cfg = JSON.parse(readFileSync(join(process.env.EMBER_HOME || join(homedir(), '.ember'), 'config.json'), 'utf8'))
          const t = cfg.todo ?? {}
          sources = SOURCES.filter((s) => t[s] !== false)
        } catch {
          sources = [...SOURCES]
        }
      }
      if (!sources.length) fail('no sources are ticked — Settings › Todo, or: todo check gmail')
      // The bookmark Ember keeps: read it so this run starts where the last one ended,
      // write it back when the run succeeds.
      const stateFile = join(process.env.EMBER_HOME || join(homedir(), '.ember'), 'todo-check.json')
      let state = {}
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf8'))
      } catch {
        /* first run */
      }
      const startedAt = new Date().toISOString()
      const args = [...sources, ...(state.lastCheckedAt ? [`since=${state.lastCheckedAt}`] : [])]
      const { spawnSync } = await import('node:child_process')
      const r = spawnSync('claude', ['-p', `/check-todos ${args.join(' ')}`, '--output-format', 'text', '--dangerously-skip-permissions'], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, EMBER_NOTES_DIR: DIR },
      })
      if ((r.status ?? 1) === 0) {
        try {
          mkdirSync(join(stateFile, '..'), { recursive: true })
          writeFileSync(stateFile, JSON.stringify({ lastCheckedAt: startedAt, sources }, null, 2), 'utf8')
        } catch {
          /* the run still happened */
        }
      }
      process.exit(r.status ?? 1)
    }
    case 'sources': {
      // Settings > Todo, from the shell: no words prints it, words set exactly those.
      const ALL = ['gmail', 'outlook', 'slack', 'jira', 'github']
      const file = join(process.env.EMBER_HOME || join(homedir(), '.ember'), 'config.json')
      let cfg = {}
      try {
        cfg = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        /* defaults */
      }
      const cur = cfg.todo ?? {}
      const chosen = words.map((w) => w.toLowerCase())
      const bad = chosen.filter((w) => !ALL.includes(w))
      if (bad.length) fail(`todo sources: unknown ${bad.join(', ')} (one of ${ALL.join(', ')})`, 2)
      if (chosen.length) {
        cfg.todo = Object.fromEntries(ALL.map((s) => [s, chosen.includes(s)]))
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
      }
      const on = ALL.filter((s) => (chosen.length ? chosen.includes(s) : cur[s] !== false))
      console.log(on.length ? on.join(' ') : 'none')
      return
    }
    case 'list':
    case 'ls': {
      // --all includes ticked items, marked [x]: what the checker needs to see so a thing
      // already handled is never added again.
      const all = flags.has('--all')
      const items = todoBody()
        .split('\n')
        .filter((l) => (all ? /^\s*- \[[ xX]\] /.test(l) : /^\s*- \[ \] /.test(l)))
        .map((l) => (all && /^\s*- \[[xX]\] /.test(l) ? `[x] ${l.replace(/^\s*- \[[xX]\] /, '')}` : l.replace(/^\s*- \[[ xX]\] /, '')))
      // Archived items count as done too; without them the checker would add a thing
      // back the day after it was cleared.
      if (all) items.push(...archivedItems())
      if (!items.length) console.log('nothing to do')
      else for (const [n, item] of items.entries()) console.log(`${String(n + 1).padStart(2)}. ${item}`)
      return
    }
    case 'clear': {
      if (words[0] !== 'done') fail('todo clear: only `todo clear done` exists — it archives the ticked items')
      const lines = todoBody().split('\n')
      const done = lines.filter((l) => /^\s*- \[[xX]\] /.test(l)).map((l) => l.replace(/^\s*- \[[xX]\] /, ''))
      if (!done.length) {
        console.log('nothing ticked')
        return
      }
      archiveAdd(done)
      writeFileSync(join(DIR, TODO), lines.filter((l) => !/^\s*- \[[xX]\] /.test(l)).join('\n'), 'utf8')
      console.log(`archived ${done.length} done item${done.length === 1 ? '' : 's'}`)
      return
    }
    case 'archive': {
      const body = archiveBody().trim()
      console.log(body || 'nothing archived yet')
      return
    }
    default:
      fail(`todo: unknown command "${sub}"\n\n${HELP}`, 2)
  }
}

if (verb === 'todo') {
  await todo(rest[0], rest.slice(1))
  process.exit(0)
}

if (flags.has('--help') || flags.has('-h') || verb === 'help') {
  console.log(HELP)
  process.exit(0)
}

switch (verb) {
  case undefined: {
    // Bare `notes`: the tab, if there is an Ember to show it in; otherwise the list.
    if (await bridge('/notes/open', { mode: 'list' })) break
    // falls through to list
  }
  // eslint-disable-next-line no-fallthrough
  case 'list':
  case 'ls': {
    const all = list()
    if (flags.has('--json')) {
      console.log(JSON.stringify(all, null, 2))
      break
    }
    if (!all.length) {
      console.log(`no notes yet — \`note something\` makes one (${DIR})`)
      break
    }
    const w = Math.min(48, Math.max(...all.map((n) => n.title.length)))
    for (const n of all) {
      const title = n.title.length > w ? `${n.title.slice(0, w - 1)}…` : n.title.padEnd(w)
      console.log(`${title}  ${when(n.modified).padEnd(10)}  ${n.id}`)
    }
    break
  }

  case 'read':
  case 'cat':
  case 'show': {
    const id = resolve(rest.join(' '))
    process.stdout.write(read(id))
    break
  }

  case 'new':
  case 'add':
  case 'create': {
    const text = rest.join(' ') || readStdin()
    const body = text ? (text.endsWith('\n') ? text : `${text}\n`) : ''
    const id = create(body)
    console.log(id)
    if (flags.has('--open')) await bridge('/notes/open', { mode: 'open', id })
    break
  }

  case 'write':
  case 'set': {
    const [ref, ...words] = rest
    const id = resolve(ref)
    const text = words.join(' ') || readStdin()
    if (!text) fail('nothing to write — give text, or pipe it in')
    const now = save(id, text.endsWith('\n') ? text : `${text}\n`)
    console.log(now)
    break
  }

  case 'append':
  case 'push': {
    const [ref, ...words] = rest
    const id = resolve(ref)
    const text = words.join(' ') || readStdin()
    if (!text) fail('nothing to append — give text, or pipe it in')
    const before = read(id)
    const sep = before.length === 0 || before.endsWith('\n') ? '' : '\n'
    const now = save(id, `${before}${sep}${text}${text.endsWith('\n') ? '' : '\n'}`)
    console.log(now)
    break
  }

  case 'delete':
  case 'rm':
  case 'remove': {
    const id = resolve(rest.join(' '))
    if (!recycle(id)) fail(`could not move ${id} to the recycle bin`)
    console.log(`recycled ${id}`)
    break
  }

  case 'open': {
    const id = rest.length ? resolve(rest.join(' ')) : ''
    if (!BRIDGE) fail('open needs an Ember tab to open it in — run this from a shell inside Ember')
    if (!(await bridge('/notes/open', id ? { mode: 'open', id } : { mode: 'list' }))) fail('could not reach Ember')
    break
  }

  case 'dir':
  case 'path':
  case 'folder':
    console.log(DIR)
    break

  default:
    fail(`notes: unknown command "${verb}"\n\n${HELP}`, 2)
}
