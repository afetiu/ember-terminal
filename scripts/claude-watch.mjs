#!/usr/bin/env node
/**
 * What a new Claude Code means for Ember's canvas (docs/specs/hybrid.md, "Keeping up with
 * Claude Code"): the transcript it draws from, the screen it reads to size the CLI, and the
 * hooks it registers. Run weekly by .github/workflows/claude-watch.yml.
 *
 *   1. `npm view @anthropic-ai/claude-code version` against docs/specs/claude-version.txt.
 *   2. On a new version: the CHANGELOG sections in between, and the Agent SDK's sdk.d.ts
 *      (`npm pack @anthropic-ai/claude-agent-sdk`) against the copy in docs/specs/sdk.d.ts —
 *      message types, control request subtypes and capability strings added or gone.
 *   3. One GitHub issue, "Claude Code <version>: what's new for Ember", with a checklist of
 *      what Ember's Claude code (canvas.ts, transcript.ts, Feed.ts, tuiScreen.ts, bridge.ts,
 *      hook.mjs) already names and what it does not.
 *
 * It changes no file in the repo and pushes nothing. Updating claude-version.txt and
 * sdk.d.ts is the issue's suggested follow-up, reviewed like any change.
 *
 *   node scripts/claude-watch.mjs [--dry] [--from <version>] [--to <version>] [--base-sdk <version>]
 *
 *   --dry        print the issue instead of opening it (no token needed)
 *   --from       compare from this version instead of claude-version.txt
 *   --to         compare to this version instead of npm's latest
 *   --base-sdk   diff against this published SDK version instead of docs/specs/sdk.d.ts
 *
 * Opening the issue needs `gh` and GH_TOKEN (the workflow's GITHUB_TOKEN). An issue with
 * the same title already there (open or closed) is not opened again.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')
const SPECS = join(REPO, 'docs', 'specs')
const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
/** Ember's code that speaks the protocol: what it names, it handles (or deliberately ignores). */
const EMBER_FILES = ['src/main/canvas.ts', 'src/main/transcript.ts', 'src/renderer/src/canvas/Feed.ts', 'src/renderer/src/canvas/tuiScreen.ts', 'src/main/bridge.ts', 'resources/hook.mjs']
const BODY_MAX = 60_000

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY = flag('--dry')
const SHELL = process.platform === 'win32'

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: SHELL ? 'cmd.exe' : '/bin/sh' }).trim()
}

const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v ?? '')
function cmp(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

// ------------------------------------------------------------------ versions

const stored = (opt('--from') ?? readFileSync(join(SPECS, 'claude-version.txt'), 'utf8')).trim()
const latest = (opt('--to') ?? sh('npm view @anthropic-ai/claude-code version')).trim()
if (!isVersion(stored) || !isVersion(latest)) {
  console.error(`not a version: stored "${stored}", latest "${latest}"`)
  process.exit(2)
}
if (cmp(latest, stored) <= 0) {
  console.log(`Claude Code ${latest}: Ember is up to date with it (docs/specs/claude-version.txt says ${stored}).`)
  process.exit(0)
}

// ------------------------------------------------------------------ the changelog

async function changelog() {
  try {
    const res = await fetch(CHANGELOG_URL)
    if (!res.ok) return { sections: [], error: `CHANGELOG: HTTP ${res.status}` }
    const text = await res.text()
    const sections = []
    let cur = null
    for (const line of text.split('\n')) {
      const h = /^##\s+(\d+\.\d+\.\d+)\s*$/.exec(line)
      if (h) {
        cur = { version: h[1], lines: [] }
        sections.push(cur)
      } else if (cur && line.trim()) cur.lines.push(line.replace(/\s+$/, ''))
    }
    return { sections: sections.filter((s) => cmp(s.version, stored) > 0 && cmp(s.version, latest) <= 0) }
  } catch (err) {
    return { sections: [], error: `CHANGELOG: ${err.message}` }
  }
}

// ------------------------------------------------------------------ the SDK's types

function packSdk(version, into) {
  const spec = `@anthropic-ai/claude-agent-sdk${version ? `@${version}` : ''}`
  const file = sh(`npm pack ${spec} --silent`, into).split('\n').pop().trim()
  execFileSync('tar', ['-xzf', file], { cwd: into })
  const pkg = JSON.parse(readFileSync(join(into, 'package', 'package.json'), 'utf8'))
  return { dts: readFileSync(join(into, 'package', 'sdk.d.ts'), 'utf8'), version: pkg.version }
}

/** A declared type's body: from `type NAME = {` to its closing `};` at the start of a line. */
function block(dts, name) {
  const re = new RegExp(`declare type ${name} = \\{\\n([\\s\\S]*?)\\n\\};`, 'm')
  return re.exec(dts)?.[1] ?? ''
}

function union(dts, name) {
  const m = new RegExp(`declare type ${name} =([^;]+);`).exec(dts)
  return m ? m[1].split('|').map((s) => s.trim()).filter((s) => /^\w+$/.test(s)) : []
}

/** What a sdk.d.ts says goes over the wire: message kinds, control subtypes, capabilities, exported names. */
function shape(raw) {
  const dts = raw.replace(/\r\n/g, '\n')
  const messages = new Map()
  for (const name of union(dts, 'SDKMessage')) {
    const body = block(dts, name)
    const type = /^ {4}type: '([^']+)';/m.exec(body)?.[1]
    const subtype = /^ {4}subtype: '([^']+)';/m.exec(body)?.[1]
    if (type) messages.set(subtype ? `${type}/${subtype}` : type, name)
  }
  const controls = new Map()
  for (const name of union(dts, 'SDKControlRequestInner')) {
    const subtype = /^ {4}subtype: '([^']+)';/m.exec(block(dts, name))?.[1]
    if (subtype) controls.set(subtype, name)
  }
  const capabilities = new Set(dts.match(/'[a-z][a-z0-9_]*_v\d+'/g)?.map((s) => s.slice(1, -1)) ?? [])
  const exported = new Set([...dts.matchAll(/^export declare (?:type|function|const|class|interface) (\w+)/gm)].map((m) => m[1]))
  return { messages, controls, capabilities, exported }
}

/** Keys of `now` (a Map or a Set) that `before` lacks. */
function added(now, before) {
  return [...now.keys()].filter((k) => !before.has(k)).sort()
}

function textDiff(a, b) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-watch-diff-'))
  try {
    writeFileSync(join(dir, 'before.d.ts'), a)
    writeFileSync(join(dir, 'after.d.ts'), b)
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '-U2', 'before.d.ts', 'after.d.ts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return ''
    } catch (err) {
      // `git diff` exits 1 when the files differ: the diff is its output.
      return String(err.stdout ?? '')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ what Ember names

function emberNames() {
  const names = new Set()
  for (const f of EMBER_FILES) {
    const p = join(REPO, f)
    if (!existsSync(p)) continue
    for (const m of readFileSync(p, 'utf8').matchAll(/['"`]([a-z][a-z0-9_]*)['"`]/g)) names.add(m[1])
  }
  return names
}

/** A message kind is named when its subtype is (or, without one, its type). */
const handles = (names, kind) => names.has(kind.includes('/') ? kind.split('/')[1] : kind)

// ------------------------------------------------------------------ the issue

const work = mkdtempSync(join(tmpdir(), 'claude-watch-'))
let body = ''
let title = ''
try {
  const { sections, error } = await changelog()
  const sdkDir = join(work, 'now')
  const baseDir = join(work, 'base')
  for (const d of [sdkDir, baseDir]) mkdirSync(d, { recursive: true })
  const now = packSdk(undefined, sdkDir)
  const baseVersion = opt('--base-sdk')
  const before = baseVersion ? packSdk(baseVersion, baseDir) : { dts: readFileSync(join(SPECS, 'sdk.d.ts'), 'utf8'), version: 'docs/specs/sdk.d.ts' }
  const A = shape(before.dts)
  const B = shape(now.dts)
  const names = emberNames()

  const newMessages = added(B.messages, A.messages)
  const goneMessages = added(A.messages, B.messages)
  const newControls = added(B.controls, A.controls)
  const goneControls = added(A.controls, B.controls)
  const newCaps = added(B.capabilities, A.capabilities)
  const newExports = added(B.exported, A.exported)
  const goneExports = added(A.exported, B.exported)
  const diff = before.dts === now.dts ? '' : textDiff(before.dts, now.dts)

  title = `Claude Code ${latest}: what's new for Ember`
  const out = []
  out.push(`Claude Code **${latest}** is out; Ember's canvas was last checked against **${stored}** (\`docs/specs/claude-version.txt\`).`)
  out.push(`Agent SDK types: \`${before.version}\` → \`${now.version}\`.`)
  out.push('')
  out.push('## Changelog')
  if (error) out.push(`_${error}_`)
  else if (!sections.length) out.push('_No sections between these versions in the CHANGELOG yet._')
  for (const s of sections) {
    out.push(`### ${s.version}`)
    out.push(...s.lines)
  }
  out.push('')
  out.push('## Protocol changes (sdk.d.ts)')
  const list = (label, items, fmt = (x) => `\`${x}\``) => out.push(`- ${label}: ${items.length ? items.map(fmt).join(', ') : 'none'}`)
  list('New stdout message kinds', newMessages, (k) => `\`${k}\` (${B.messages.get(k)})`)
  list('Message kinds gone', goneMessages)
  list('New control request subtypes', newControls, (k) => `\`${k}\` (${B.controls.get(k)})`)
  list('Control request subtypes gone', goneControls)
  list('New capability strings', newCaps)
  list('New exported types', newExports)
  list('Exported types gone', goneExports)
  out.push('')
  out.push('## Checklist for Ember')
  out.push('Ticked = the name appears in Ember\'s Claude code (' + EMBER_FILES.map((f) => `\`${f.split('/').pop()}\``).join(', ') + '). Unknown messages are ignored, never fatal; unknown control requests from Claude Code are answered with an error.')
  const check = (kind, label, ok) => out.push(`- [${ok ? 'x' : ' '}] ${label} \`${kind}\``)
  if (!newMessages.length && !newControls.length && !newCaps.length) out.push('- [ ] Nothing new on the wire: read the changelog for behaviour changes (TUI-only commands, flags, settings).')
  for (const k of newMessages) check(k, 'message', handles(names, k))
  for (const k of newControls) check(k, 'control request', names.has(k))
  for (const k of newCaps) check(k, 'capability', names.has(k))
  out.push('- [ ] Read the changelog for transcript (JSONL) format changes, TUI layout changes (input box, dialogs, pickers, queue: `tuiScreen.ts` reads them to size the CLI), and hook input changes.')
  out.push('- [ ] Run `scripts/probe-hybrid.mjs` and `scripts/probe-clear.mjs` against the new `claude`.')
  out.push(`- [ ] Update \`docs/specs/claude-version.txt\` to \`${latest}\` and \`docs/specs/sdk.d.ts\` to SDK \`${now.version}\` in a PR.`)
  out.push('')
  out.push('<details><summary>Everything on the wire today, and whether Ember names it</summary>')
  out.push('')
  out.push('Messages: ' + [...B.messages.keys()].sort().map((k) => `${handles(names, k) ? '✓' : '·'} \`${k}\``).join(', '))
  out.push('')
  out.push('Control requests: ' + [...B.controls.keys()].sort().map((k) => `${names.has(k) ? '✓' : '·'} \`${k}\``).join(', '))
  out.push('')
  out.push('</details>')
  if (diff) {
    out.push('')
    out.push('<details><summary>sdk.d.ts diff</summary>')
    out.push('')
    out.push('```diff')
    out.push('@@DIFF@@')
    out.push('```')
    out.push('</details>')
  }
  out.push('')
  out.push('_Opened by `.github/workflows/claude-watch.yml` (`scripts/claude-watch.mjs`). It changes no code._')
  body = out.join('\n')
  if (diff) {
    const room = BODY_MAX - body.length
    // An issue body holds 64 kB; the whole diff is one --dry run away.
    const cut = !DRY && diff.length > room ? `${diff.slice(0, Math.max(0, room - 200))}\n… (${diff.length - room + 200} more characters: run scripts/claude-watch.mjs --dry for all of it)` : diff
    body = body.replace('@@DIFF@@', cut.replace(/```/g, '``​`'))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (DRY) {
  console.log(`# ${title}\n`)
  console.log(body)
  process.exit(0)
}

// One issue per version: not again if one with this title exists, open or closed.
const existing = JSON.parse(sh(`gh issue list --state all --limit 100 --search ${JSON.stringify(`"${title}" in:title`)} --json title`) || '[]')
if (existing.some((i) => i.title === title)) {
  console.log(`An issue "${title}" is already there.`)
  process.exit(0)
}
const file = join(tmpdir(), `claude-watch-${Date.now()}.md`)
writeFileSync(file, body)
try {
  const url = execFileSync('gh', ['issue', 'create', '--title', title, '--body-file', file], { encoding: 'utf8' }).trim()
  console.log(`Opened ${url}`)
} finally {
  rmSync(file, { force: true })
}
