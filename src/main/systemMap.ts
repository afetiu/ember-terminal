import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'
import { cleanEnv } from './pty/ConPtyHost.js'
import { ignoreSession } from './mapLive.js'
import { runAgent, killTree as killAgent, defaultAgent, type AgentRun } from './agents.js'
import { agentSpec } from '../shared/agents.js'
import type {
  MapAskEvent,
  MapBundle,
  MapChange,
  MapChangeItem,
  MapEdge,
  MapFlow,
  MapHistoryEntry,
  MapJob,
  MapModel,
  MapNode,
  MapNote,
  MapProject,
  MapState,
  MapSummary,
  MapWatch,
} from '../shared/types.js'

/**
 * The map: a living architecture model of a project.
 *
 * The one idea everything here serves is that the model is *kept*, not *drawn*. Claude
 * builds it once, from everything it can find — folders, GitHub, Heroku, docs, memory —
 * and after that it is only ever patched. A patch names nodes by ids that never change,
 * so the picture the user has learned stays the picture, and every difference between two
 * versions is a real difference in the system rather than a model re-describing the same
 * thing in fresh words.
 *
 * Two loops, very different in cost:
 *
 *   - **Checking** is cheap and has no AI in it. Each project lists *watches* — a local
 *     repo's HEAD, a GitHub repo's last push, a Heroku app's release, a URL's status —
 *     and a check fingerprints them. It runs every few minutes, forever.
 *   - **Updating** is Claude. It runs only when a fingerprint moved, is handed the model,
 *     the evidence of what moved (git logs gathered here, not by the model) and is asked
 *     for operations, never a new model. The operations are applied here, validated,
 *     and recorded as one entry in the project's history.
 *
 * Everything is read-only. Claude runs headless with a tool allowlist that can look and
 * cannot write; a change the user wants is a separate, ordinary session he opens from the map.
 *
 * On disk, per project, under ~/.ember/maps/<id>/:
 *   project.json   what the user set up        model.json    the current model
 *   changes.json   the history, newest last state.json   fingerprints, the running job
 *   history/       every version of the model, for "what did it look like then"
 */

export const MAPS_DIR = join(CONFIG_DIR, 'maps')
const HOME = homedir()
const MAX_CHANGES = 400
const MAX_HISTORY = 60

type Emit = (channel: string, payload: unknown) => void
let emit: Emit = () => {}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

function dirOf(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id)) throw new Error(`bad project id: ${id}`)
  return join(MAPS_DIR, id)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

/** Write-then-rename, so a crash mid-write leaves the old file rather than half a new one. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base || 'project'
}

export function listProjects(): MapSummary[] {
  if (!existsSync(MAPS_DIR)) return []
  const out: MapSummary[] = []
  for (const id of readdirSync(MAPS_DIR)) {
    try {
      const b = load(id)
      if (!b) continue
      const seen = b.state.lastViewedAt ? Date.parse(b.state.lastViewedAt) : 0
      out.push({
        project: b.project,
        nodes: b.model?.nodes.length ?? 0,
        version: b.model?.version ?? 0,
        ...(b.model ? { updatedAt: b.model.updatedAt } : {}),
        unseen: b.changes.filter((c) => Date.parse(c.at) > seen).length,
        job: jobs.get(id) ?? null,
        ...(b.state.lastError ? { lastError: b.state.lastError } : {}),
      })
    } catch {
      /* a broken folder is skipped, not fatal */
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? b.project.createdAt).localeCompare(a.updatedAt ?? a.project.createdAt))
}

export function load(id: string): MapBundle | null {
  const dir = dirOf(id)
  const project = readJson<MapProject | null>(join(dir, 'project.json'), null)
  if (!project) return null
  return {
    project,
    model: withDefaults(readJson<MapModel | null>(join(dir, 'model.json'), null)),
    changes: readJson<MapChange[]>(join(dir, 'changes.json'), []),
    state: { ...readJson<MapState>(join(dir, 'state.json'), { fingerprints: {}, watchErrors: {} }), job: jobs.get(id) ?? null },
  }
}

function withDefaults(m: MapModel | null): MapModel | null {
  if (m && !Array.isArray(m.flows)) m.flows = []
  return m
}

export function listHistory(id: string): MapHistoryEntry[] {
  const hist = join(dirOf(id), 'history')
  if (!existsSync(hist)) return []
  const out: MapHistoryEntry[] = []
  for (const f of readdirSync(hist).filter((x) => /^v\d+\.json$/.test(x)).sort()) {
    const m = readJson<MapModel | null>(join(hist, f), null)
    if (m) out.push({ version: m.version, at: m.updatedAt })
  }
  return out
}

export function loadVersion(id: string, version: number): MapModel | null {
  return withDefaults(readJson<MapModel | null>(join(dirOf(id), 'history', `v${String(version).padStart(5, '0')}.json`), null))
}

function saveState(id: string, patch: Partial<MapState>): void {
  const file = join(dirOf(id), 'state.json')
  const cur = readJson<MapState>(file, { fingerprints: {}, watchErrors: {} })
  const next = { ...cur, ...patch }
  delete next.job
  writeJson(file, next)
}

export function createProject(input: { name: string; brief: string; pollMinutes?: number }): MapProject {
  mkdirSync(MAPS_DIR, { recursive: true })
  let id = slug(input.name)
  for (let n = 2; existsSync(join(MAPS_DIR, id)); n++) id = `${slug(input.name)}-${n}`
  const project: MapProject = {
    id,
    name: input.name.trim() || id,
    brief: input.brief.trim(),
    pollMinutes: input.pollMinutes ?? 10,
    createdAt: new Date().toISOString(),
  }
  mkdirSync(join(MAPS_DIR, id, 'history'), { recursive: true })
  writeJson(join(MAPS_DIR, id, 'project.json'), project)
  writeJson(join(MAPS_DIR, id, 'state.json'), { fingerprints: {}, watchErrors: {} })
  changed(id)
  return project
}

export function updateProject(id: string, patch: Partial<Pick<MapProject, 'name' | 'brief' | 'pollMinutes'>>): MapProject | null {
  const b = load(id)
  if (!b) return null
  const next = { ...b.project, ...patch }
  writeJson(join(dirOf(id), 'project.json'), next)
  changed(id)
  return next
}

export function deleteProject(id: string): boolean {
  cancelJob(id)
  const dir = dirOf(id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  emit('ember:map:changed', { id, deleted: true })
  return true
}

export function markViewed(id: string): void {
  if (!existsSync(join(dirOf(id), 'project.json'))) return
  saveState(id, { lastViewedAt: new Date().toISOString() })
}

function changed(id: string): void {
  emit('ember:map:changed', { id })
}

function saveModel(id: string, model: MapModel): void {
  const dir = dirOf(id)
  writeJson(join(dir, 'model.json'), model)
  const hist = join(dir, 'history')
  mkdirSync(hist, { recursive: true })
  writeJson(join(hist, `v${String(model.version).padStart(5, '0')}.json`), model)
  const files = readdirSync(hist).filter((f) => f.endsWith('.json')).sort()
  for (const f of files.slice(0, Math.max(0, files.length - MAX_HISTORY))) {
    try {
      unlinkSync(join(hist, f))
    } catch {
      /* best effort */
    }
  }
}

function appendChange(id: string, change: MapChange): void {
  const file = join(dirOf(id), 'changes.json')
  const all = readJson<MapChange[]>(file, [])
  all.push(change)
  writeJson(file, all.slice(-MAX_CHANGES))
}

// ---------------------------------------------------------------------------
// claude, headless and read-only
// ---------------------------------------------------------------------------

/**
 * What a map run may use. Looking, never touching: files, search, git history, GitHub
 * and Heroku reads, the web. No Edit or Write, and Bash only for the named read commands
 * — anything else is refused by Claude Code itself in `-p` mode, not by our asking nicely.
 */
const READ_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git branch:*)',
  'Bash(git remote:*)',
  'Bash(git rev-parse:*)',
  'Bash(git ls-files:*)',
  'Bash(git ls-remote:*)',
  'Bash(git -C:*)',
  'Bash(gh repo view:*)',
  'Bash(gh repo list:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr view:*)',
  'Bash(gh run list:*)',
  'Bash(gh release list:*)',
  'Bash(gh api:*)',
  'Bash(gh search:*)',
  'Bash(heroku apps:*)',
  'Bash(heroku releases:*)',
  'Bash(heroku ps:*)',
  'Bash(heroku addons:*)',
  'Bash(heroku domains:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(find:*)',
  'Bash(wc:*)',
]

const NEVER_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(rm:*)']

type ClaudeRun = AgentRun

/**
 * A map run, through whichever agent CLI is chosen. Claude Code gets the exact tool list
 * above and a known session id, so the live view can tell the map's own reading from real
 * work; every other CLI runs in its own read-only mode.
 */
function runClaude(prompt: string, opts: { cwd?: string; timeoutMs: number; onLine?: (line: string) => void }): ClaudeRun {
  const sessionId = randomUUID()
  ignoreSession(sessionId)
  return runAgent(prompt, {
    ...opts,
    args: {
      claude: ['--session-id', sessionId, '--allowedTools', READ_TOOLS.join(','), '--disallowedTools', NEVER_TOOLS.join(',')],
    },
  })
}

function killTree(child: ChildProcess): void {
  killAgent(child)
}

/** The last ```json block, or failing that the outermost braces. */
function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fences[i]![1]!)
    } catch {
      /* try the next one */
    }
  }
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1))
  throw new Error('no JSON in the answer')
}

// ---------------------------------------------------------------------------
// the model: validating what Claude hands back
// ---------------------------------------------------------------------------

const KINDS = new Set(['system', 'group', 'repo', 'app', 'service', 'component', 'module', 'datastore', 'queue', 'infra', 'external', 'job', 'doc'])
const STATUSES = new Set(['ok', 'warn', 'down', 'unknown'])

function cleanId(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function cleanNode(raw: Record<string, unknown>): MapNode | null {
  const id = cleanId(raw['id'])
  if (!id) return null
  const str = (k: string, max = 4000) => (typeof raw[k] === 'string' ? (raw[k] as string).slice(0, max) : undefined)
  const node: MapNode = {
    id,
    name: str('name', 120) || id,
    kind: (KINDS.has(String(raw['kind'])) ? raw['kind'] : 'component') as MapNode['kind'],
    summary: str('summary', 600) ?? '',
  }
  const parent = cleanId(raw['parent'])
  if (parent && parent !== id) node.parent = parent
  const details = str('details', 12000)
  if (details) node.details = details
  if (Array.isArray(raw['tech'])) node.tech = (raw['tech'] as unknown[]).map(String).slice(0, 12)
  if (STATUSES.has(String(raw['status']))) node.status = raw['status'] as MapNode['status']
  const note = str('statusNote', 300)
  if (note) node.statusNote = note
  const path = str('path', 400)
  if (path) node.path = path
  const sources = cleanRefs(raw['sources'])
  if (sources.length) node.sources = sources
  const deploy = str('deploy', 120)
  if (deploy) node.deploy = deploy
  const notes = cleanNotes(raw['notes'])
  if (notes.length) node.notes = notes
  return node
}

function cleanRefs(raw: unknown): MapNode['sources'] & object {
  if (!Array.isArray(raw)) return []
  return (raw as Array<Record<string, unknown>>)
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      label: String(s['label'] ?? s['url'] ?? s['path'] ?? '').slice(0, 120),
      ...(typeof s['url'] === 'string' ? { url: s['url'] } : {}),
      ...(typeof s['path'] === 'string' ? { path: s['path'] } : {}),
    }))
    .filter((s) => s.label)
    .slice(0, 12)
}

const NOTE_TYPES = new Set(['risk', 'question', 'decision', 'pr', 'issue', 'todo', 'cost', 'date', 'person', 'note'])

function cleanNotes(raw: unknown): MapNote[] {
  if (!Array.isArray(raw)) return []
  return (raw as Array<Record<string, unknown>>)
    .filter((n) => n && typeof n === 'object' && typeof n['text'] === 'string')
    .map((n) => ({
      type: (NOTE_TYPES.has(String(n['type'])) ? n['type'] : 'note') as MapNote['type'],
      text: String(n['text']).slice(0, 400),
      ...(typeof n['url'] === 'string' ? { url: n['url'] } : {}),
    }))
    .slice(0, 20)
}

function cleanFlows(raw: unknown, ids: Set<string>): MapFlow[] {
  if (!Array.isArray(raw)) return []
  const out: MapFlow[] = []
  for (const f of raw as Array<Record<string, unknown>>) {
    if (!f || typeof f !== 'object') continue
    const id = cleanId(f['id'] ?? f['name'])
    const steps = (Array.isArray(f['steps']) ? (f['steps'] as Array<Record<string, unknown>>) : [])
      .map((st) => ({ node: cleanId(st?.['node']), ...(typeof st?.['text'] === 'string' ? { text: String(st['text']).slice(0, 200) } : {}) }))
      .filter((st) => ids.has(st.node))
    if (!id || steps.length < 2) continue
    out.push({ id, name: String(f['name'] ?? id).slice(0, 80), summary: String(f['summary'] ?? '').slice(0, 400), steps: steps.slice(0, 16) })
  }
  return out.slice(0, 16)
}

function cleanWatch(raw: Record<string, unknown>): MapWatch | null {
  const kind = String(raw['kind'])
  const target = String(raw['target'] ?? '').trim()
  if (!target || !['git', 'github', 'heroku', 'url'].includes(kind)) return null
  return { kind: kind as MapWatch['kind'], target, ...(raw['label'] ? { label: String(raw['label']).slice(0, 80) } : {}) }
}

/** Parents that point nowhere become roots; a cycle is broken where it closes. */
function repairTree(nodes: MapNode[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) if (n.parent && !byId.has(n.parent)) delete n.parent
  for (const n of nodes) {
    const seen = new Set<string>([n.id])
    let p = n.parent ? byId.get(n.parent) : undefined
    while (p) {
      if (seen.has(p.id)) {
        delete n.parent
        break
      }
      seen.add(p.id)
      p = p.parent ? byId.get(p.parent) : undefined
    }
  }
}

function cleanEdges(raw: unknown, ids: Set<string>): MapEdge[] {
  const out = new Map<string, MapEdge>()
  for (const e of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
    const from = cleanId(e?.['from'])
    const to = cleanId(e?.['to'])
    if (!ids.has(from) || !ids.has(to) || from === to) continue
    const id = cleanId(e['id']) || `${from}--${to}`
    const sources = cleanRefs(e['sources'])
    out.set(id, {
      id,
      from,
      to,
      ...(e['label'] ? { label: String(e['label']).slice(0, 60) } : {}),
      ...(typeof e['detail'] === 'string' ? { detail: e['detail'].slice(0, 800) } : {}),
      ...(typeof e['protocol'] === 'string' ? { protocol: e['protocol'].slice(0, 40) } : {}),
      ...(sources.length ? { sources } : {}),
    })
  }
  return [...out.values()]
}

function modelFrom(raw: Record<string, unknown>, version: number): MapModel {
  const nodes = new Map<string, MapNode>()
  for (const r of Array.isArray(raw['nodes']) ? (raw['nodes'] as Array<Record<string, unknown>>) : []) {
    const n = r && typeof r === 'object' ? cleanNode(r) : null
    if (n && !nodes.has(n.id)) nodes.set(n.id, n)
  }
  const list = [...nodes.values()]
  repairTree(list)
  const ids = new Set(nodes.keys())
  if (!list.length) throw new Error('the map came back empty')
  return {
    version,
    updatedAt: new Date().toISOString(),
    overview: typeof raw['overview'] === 'string' ? raw['overview'].slice(0, 2000) : '',
    nodes: list,
    edges: cleanEdges(raw['edges'], ids),
    watches: (Array.isArray(raw['watches']) ? (raw['watches'] as Array<Record<string, unknown>>) : [])
      .map((w) => (w && typeof w === 'object' ? cleanWatch(w) : null))
      .filter((w): w is MapWatch => !!w)
      .slice(0, 40),
    flows: cleanFlows(raw['flows'], ids),
  }
}

/**
 * Apply an update's operations to a copy of the model. Anything that does not fit — an
 * edge to a node that is not there, an update to an id that never existed — is dropped,
 * not guessed at; the history records what actually landed.
 */
function applyOps(model: MapModel, ops: unknown[]): { model: MapModel; touched: Set<string>; added: Set<string>; removed: MapNode[] } {
  const next: MapModel = JSON.parse(JSON.stringify(model)) as MapModel
  const touched = new Set<string>()
  const added = new Set<string>()
  const removed: MapNode[] = []
  const byId = () => new Map(next.nodes.map((n) => [n.id, n]))

  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') continue
    const op = raw as Record<string, unknown>
    switch (op['op']) {
      case 'add_node': {
        const n = cleanNode((op['node'] ?? {}) as Record<string, unknown>)
        if (!n) break
        const i = next.nodes.findIndex((x) => x.id === n.id)
        if (i >= 0) next.nodes[i] = { ...next.nodes[i]!, ...n }
        else {
          next.nodes.push(n)
          added.add(n.id)
        }
        touched.add(n.id)
        break
      }
      case 'update_node': {
        const id = cleanId(op['id'])
        const cur = byId().get(id)
        if (!cur) break
        const merged = cleanNode({ ...cur, ...((op['set'] ?? {}) as Record<string, unknown>), id })
        if (!merged) break
        Object.assign(cur, merged)
        touched.add(id)
        break
      }
      case 'remove_node': {
        const id = cleanId(op['id'])
        if (!byId().has(id)) break
        // A removed node takes its subtree with it; children of a deleted repo are not
        // floating free, they are gone too.
        const gone = new Set([id])
        for (let grew = true; grew; ) {
          grew = false
          for (const n of next.nodes) {
            if (n.parent && gone.has(n.parent) && !gone.has(n.id)) {
              gone.add(n.id)
              grew = true
            }
          }
        }
        for (const n of next.nodes) if (gone.has(n.id) && !added.has(n.id)) removed.push(n)
        next.nodes = next.nodes.filter((n) => !gone.has(n.id))
        next.edges = next.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to))
        for (const f of next.flows) f.steps = f.steps.filter((st) => !gone.has(st.node))
        next.flows = next.flows.filter((f) => f.steps.length >= 2)
        for (const g of gone) touched.add(g)
        break
      }
      case 'add_edge': {
        const ids = new Set(next.nodes.map((n) => n.id))
        const [e] = cleanEdges([op['edge']], ids)
        if (!e) break
        next.edges = next.edges.filter((x) => x.id !== e.id)
        next.edges.push(e)
        touched.add(e.from)
        touched.add(e.to)
        break
      }
      case 'remove_edge': {
        const id = cleanId(op['id'])
        const e = next.edges.find((x) => x.id === id)
        if (!e) break
        next.edges = next.edges.filter((x) => x.id !== id)
        touched.add(e.from)
        touched.add(e.to)
        break
      }
      case 'update_edge': {
        const id = cleanId(op['id'])
        const i = next.edges.findIndex((x) => x.id === id)
        if (i < 0) break
        const ids = new Set(next.nodes.map((n) => n.id))
        const [e] = cleanEdges([{ ...next.edges[i], ...((op['set'] ?? {}) as Record<string, unknown>), id }], ids)
        if (!e) break
        next.edges[i] = e
        touched.add(e.from)
        touched.add(e.to)
        break
      }
      case 'add_flow':
      case 'update_flow': {
        const ids = new Set(next.nodes.map((n) => n.id))
        const [f] = cleanFlows([op['flow']], ids)
        if (!f) break
        next.flows = next.flows.filter((x) => x.id !== f.id)
        next.flows.push(f)
        break
      }
      case 'remove_flow': {
        const id = cleanId(op['id'])
        next.flows = next.flows.filter((f) => f.id !== id)
        break
      }
      case 'set_overview':
        if (typeof op['text'] === 'string') next.overview = op['text'].slice(0, 2000)
        break
      case 'add_watch': {
        const w = cleanWatch((op['watch'] ?? {}) as Record<string, unknown>)
        if (w && !next.watches.some((x) => x.kind === w.kind && x.target === w.target)) next.watches.push(w)
        break
      }
      case 'remove_watch': {
        const t = String(op['target'] ?? '')
        next.watches = next.watches.filter((w) => w.target !== t)
        break
      }
    }
  }
  repairTree(next.nodes)
  return { model: next, touched, added, removed }
}

/** For a rebuild: what differs between two whole models, as a change entry would say it. */
function diffModels(a: MapModel, b: MapModel): { items: MapChangeItem[]; touched: Set<string>; added: string[]; removed: MapNode[] } {
  const A = new Map(a.nodes.map((n) => [n.id, n]))
  const B = new Map(b.nodes.map((n) => [n.id, n]))
  const items: MapChangeItem[] = []
  const touched = new Set<string>()
  const added: string[] = []
  const removed: MapNode[] = []
  for (const [id, n] of B) {
    const old = A.get(id)
    if (!old) {
      added.push(id)
      items.push({ node: id, text: `Added ${n.name}`, impact: 'notable' })
      touched.add(id)
    } else if (old.parent !== n.parent || old.status !== n.status || old.kind !== n.kind) {
      // Only what actually moved. A re-survey rewords every summary; that is not news.
      const what = old.status !== n.status ? `now ${n.status}${n.statusNote ? ` — ${n.statusNote}` : ''}` : old.parent !== n.parent ? 'moved' : `is now a ${n.kind}`
      items.push({ node: id, text: `${n.name} ${what}`, impact: old.status !== n.status && n.status === 'down' ? 'major' : 'minor' })
      touched.add(id)
    }
  }
  for (const [id, n] of A) {
    if (!B.has(id)) {
      items.push({ text: `Removed ${n.name}`, impact: 'notable' })
      touched.add(id)
      removed.push(n)
    }
  }
  return { items, touched, added, removed }
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

const SCHEMA = `{
  "overview": "3-6 sentences: what this system is, what it is for, how the big parts fit together, what state it is in.",
  "nodes": [
    {
      "id": "stable-kebab-id",
      "name": "Human name",
      "kind": "system|group|repo|app|service|component|module|datastore|queue|infra|external|job|doc",
      "parent": "id of the containing node, omitted for top level",
      "summary": "1-2 plain sentences: what it is and what it does.",
      "details": "markdown: how it works, key files/folders, config (env var NAMES only, never values), how it is built and deployed, known problems",
      "tech": ["Angular 19", "MongoDB"],
      "status": "ok|warn|down|unknown",
      "statusNote": "why, when not ok",
      "path": "C:\\\\code\\\\some-repo (local folder, when it has one)",
      "deploy": "where it runs, short: the platform and the app or service name | local only | SaaS",
      "notes": [{ "type": "risk|question|decision|pr|issue|todo|cost|date|person|note", "text": "one line", "url": "optional link" }],
      "sources": [{ "label": "GitHub", "url": "https://github.com/..." }, { "label": "server.ts", "path": "C:\\\\code\\\\repo\\\\server.ts" }]
    }
  ],
  "edges": [{ "from": "id of the caller / the dependent", "to": "id of what it uses", "label": "2-4 words: calls, reads/writes, deploys to, auth via…", "protocol": "HTTPS | SQL | webhook | SDK | git | DNS | file…", "detail": "what travels along it, where it is wired in code", "sources": [{ "label": "file", "path": "C:\\\\..." }] }],
  "flows": [{ "id": "flow-kebab-id", "name": "Buyer downloads a zip", "summary": "one sentence", "steps": [{ "node": "id", "text": "what happens at this step" }] }],
  "watches": [
    { "kind": "git", "target": "C:\\\\code\\\\some-repo" },
    { "kind": "github", "target": "owner/repo" },
    { "kind": "heroku", "target": "heroku-app-name" },
    { "kind": "url", "target": "https://the-live-site" }
  ]
}`

const RULES = `Rules:
- You are READ-ONLY. Look at anything; never change, create, push, deploy or delete anything.
- Never write secret values (keys, tokens, passwords, connection strings) anywhere in your answer. Names of env vars are fine.
- Ids are forever: lowercase kebab-case derived from the real name of the thing (repo-radix-api, svc-auth, db-radix-mongo). Later updates refer to nodes by these ids, and the whole history hangs off them.
- The hierarchy is the zoom. Top level: 3-8 big areas or systems (use kind "group" or "system"). Inside them: repos, apps, services, datastores, infrastructure, external services, jobs. Inside those: the components and modules worth knowing about. Go one level deeper only where it helps understanding. 25-150 nodes total.
- Edges are the important relationships (calls, reads/writes, deploys to, authenticates with, publishes to). Direction: FROM the part that depends/acts TO the part it uses, so the map reads left to right as "uses". Connect the most specific nodes that are true.
- Flows: the 3-8 journeys that matter most (a user action end to end, a payment, a deploy, a scheduled job, data coming in). Each is an ordered list of 3-10 steps across existing node ids.
- notes: pin the project's wider world to the part it concerns — open PRs and issues, risks, open questions and decisions waiting on the owner, costs, deadlines/dates, people involved, relevant todo items. Only real, current things you found evidence for; one line each.
- deploy: where each deployable part runs (and "local only" when it runs nowhere).
- Summaries are for someone who owns the system but no longer reads every PR: plain, concrete, no marketing.
- status: "ok" when running/healthy as far as you can tell, "warn" when something is off (failing CI, scaled to zero, stale, TODO blocking), "down" when broken, "unknown" when you cannot tell.
- Git: use "git -C <path> <read command>". If the project is hosted somewhere whose CLI is installed and signed in (for example gh for GitHub), you may use its read-only commands; never anything that changes state. Do not assume any particular host — find out from the repo.`

/**
 * Where a Claude Code memory for this home folder lives, if it exists. It often says what
 * runs where; other agents keep nothing comparable, so the line is simply left out.
 */
function memoryHint(): string {
  const slug = HOME.replace(/[:\/]/g, '-')
  const dir = join(HOME, '.claude', 'projects', slug, 'memory')
  return existsSync(join(dir, 'MEMORY.md'))
    ? ` There is a Claude Code memory at ${dir} (MEMORY.md is the index) that often says what runs where and what state it is in.`
    : ''
}

function buildPrompt(p: MapProject, old: MapModel | null): string {
  return [
    `You are building a living architecture map of a software project for its owner. It is shown in their terminal app (Ember) as a zoomable map they read to understand the whole system — code, infrastructure, deployments, data, external services, docs — without reading individual PRs.`,
    ``,
    `Project: ${p.name}`,
    `What the owner said about it:`,
    p.brief || '(nothing more — find it)',
    ``,
    `Find everything that belongs to this project, across repos and beyond them. Their projects usually live under ${HOME} (one folder each). Start from what they said, then follow the evidence: package.json / requirements and other manifests, container and deployment config, CI workflows, env var names, READMEs, CLAUDE.md / AGENTS.md / GEMINI.md and docs/ folders, git remotes, and the live URLs they point at.${memoryHint()} Be thorough, then be selective about what goes on the map.`,
    ``,
    old
      ? `There is already a map of this project. Keep every id that still describes something real, keep names stable, and only add, change or drop what reality requires. The current map:\n\`\`\`json\n${JSON.stringify(old)}\n\`\`\`\n`
      : '',
    RULES,
    ``,
    `The watches are what will be polled every few minutes (cheaply, without you) to notice that something changed: list every local repo and live URL that belongs to the project, plus its GitHub repo or Heroku app when it has one (those two are the hosts Ember can poll cheaply; anything else is covered by the repo and the URL).`,
    ``,
    `When you are done looking, answer with exactly one \`\`\`json block in this shape and nothing after it:`,
    SCHEMA,
  ].join('\n')
}

function updatePrompt(p: MapProject, model: MapModel, evidence: string): string {
  return [
    `You keep a living architecture map of the project "${p.name}" for its owner. The map is a persistent model: you do not redraw it, you patch it so it matches reality again. The owner reads the history of your patches to understand how their system is changing, so the summary and the change items matter as much as the operations.`,
    ``,
    `What the owner said about the project: ${p.brief || '(nothing)'}`,
    ``,
    `The current map:`,
    '```json',
    JSON.stringify(model),
    '```',
    ``,
    `What moved since the map was last updated (gathered automatically):`,
    evidence,
    ``,
    `Investigate as much as you need (read the changed files, the diffs, the PRs, the deploys) to understand what these changes mean for the system — its components, how they connect, how it is deployed, its health. Then answer with operations against the map.`,
    ``,
    RULES,
    `- Reuse existing ids. Only add a node for something genuinely new; only remove one that is genuinely gone.`,
    `- Update summaries/details/status/tech/notes only where the change actually alters them. Do not rephrase things that did not change. Keep notes current: drop a PR note once merged, a risk once resolved.`,
    `- If nothing architecturally relevant changed, return no ops but still say in the summary what the changes were.`,
    ``,
    `Answer with exactly one \`\`\`json block and nothing after it:`,
    '```',
    `{
  "summary": "1-3 sentences in plain words: what happened to the system.",
  "changes": [{ "node": "id or omitted", "text": "one concrete sentence", "impact": "minor|notable|major" }],
  "ops": [
    { "op": "add_node", "node": { ...full node as in the map... } },
    { "op": "update_node", "id": "existing-id", "set": { "summary": "...", "status": "warn", "statusNote": "..." } },
    { "op": "remove_node", "id": "existing-id" },
    { "op": "add_edge", "edge": { "from": "id", "to": "id", "label": "..." } },
    { "op": "remove_edge", "id": "existing-edge-id" },
    { "op": "update_edge", "id": "existing-edge-id", "set": { "detail": "...", "label": "..." } },
    { "op": "add_flow", "flow": { "id": "...", "name": "...", "summary": "...", "steps": [{ "node": "id", "text": "..." }] } },
    { "op": "remove_flow", "id": "flow-id" },
    { "op": "set_overview", "text": "..." },
    { "op": "add_watch", "watch": { "kind": "git|github|heroku|url", "target": "..." } },
    { "op": "remove_watch", "target": "..." }
  ]
}`,
    '```',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// watches: the cheap loop
// ---------------------------------------------------------------------------

function sh(cmd: string, args: string[], timeout = 20_000, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, shell: cmd !== 'git', cwd, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]?.slice(0, 200)))
      else resolve(String(stdout))
    })
  })
}

const watchKey = (w: MapWatch) => `${w.kind}:${w.target}`

async function fingerprint(w: MapWatch): Promise<string> {
  switch (w.kind) {
    case 'git': {
      const head = (await sh('git', ['-C', w.target, 'rev-parse', 'HEAD'])).trim()
      const branch = (await sh('git', ['-C', w.target, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      return `${branch}@${head}`
    }
    case 'github': {
      if (!/^[\w.-]+\/[\w.-]+$/.test(w.target)) throw new Error('not owner/repo')
      return (await sh('gh', ['api', `repos/${w.target}`, '--jq', '.pushed_at'])).trim()
    }
    case 'heroku': {
      if (!/^[\w-]+$/.test(w.target)) throw new Error('not an app name')
      const rel = JSON.parse(await sh('heroku', ['releases', '-a', w.target, '-n', '1', '--json'], 30_000)) as Array<{ version?: number }>
      const ps = JSON.parse(await sh('heroku', ['ps', '-a', w.target, '--json'], 30_000)) as Array<{ type?: string; state?: string }>
      const dynos = ps.map((d) => `${d.type}:${d.state}`).sort().join(',') || 'no dynos'
      return `v${rel[0]?.version ?? '?'} ${dynos}`
    }
    case 'url': {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 12_000)
      try {
        const r = await fetch(w.target, { method: 'GET', redirect: 'follow', signal: ctl.signal })
        return `HTTP ${Math.floor(r.status / 100)}xx`
      } catch (e) {
        return `unreachable (${(e as Error).name})`
      } finally {
        clearTimeout(t)
      }
    }
  }
}

/** For a moved git watch: the commits and the shape of the diff, so Claude starts informed. */
async function gitEvidence(w: MapWatch, was: string | undefined, now: string): Promise<string> {
  const newSha = now.split('@')[1] ?? 'HEAD'
  const oldSha = was?.split('@')[1]
  const range = oldSha ? `${oldSha}..${newSha}` : `${newSha}~15..${newSha}`
  try {
    const log = await sh('git', ['-C', w.target, 'log', '--no-merges', '--format=%h %ad %an: %s', '--date=short', '-n', '60', range])
    const stat = await sh('git', ['-C', w.target, 'diff', '--stat=120', '--stat-count=40', oldSha ?? `${newSha}~15`, newSha]).catch(() => '')
    return [`Repo ${w.target}: ${was ?? '(first seen)'} -> ${now}`, 'Commits:', log.trim() || '(none — history was rewritten or the branch switched)', 'Diff stat:', stat.trim()].join('\n')
  } catch {
    return `Repo ${w.target}: ${was ?? '(first seen)'} -> ${now} (could not read the log; the old commit may be gone — look at recent history yourself)`
  }
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

const jobs = new Map<string, MapJob>()
const running = new Map<string, ChildProcess>()
/** One Claude job at a time across all projects: these are big, and the machine is shared. */
let queue: Promise<unknown> = Promise.resolve()

function setJob(id: string, job: MapJob | null): void {
  if (job) jobs.set(id, job)
  else jobs.delete(id)
  emit('ember:map:job', { id, job })
}

function progress(id: string, line: string): void {
  const j = jobs.get(id)
  if (!j) return
  j.line = line
  emit('ember:map:job', { id, job: j })
}

export function cancelJob(id: string): void {
  const c = running.get(id)
  if (c) killTree(c)
}

/** Build from nothing, or rebuild keeping ids. By hand, or when a project is created. */
export function build(id: string, rebuild = false): Promise<void> {
  if (jobs.has(id)) return Promise.resolve()
  setJob(id, { kind: rebuild ? 'rebuild' : 'build', startedAt: new Date().toISOString(), line: 'Waiting for Claude…' })
  const task = async () => {
    const b = load(id)
    if (!b) return setJob(id, null)
    progress(id, `${agentSpec(defaultAgent()).name} is looking around…`)
    const run = runClaude(buildPrompt(b.project, rebuild ? b.model : null), { timeoutMs: 25 * 60_000, onLine: (l) => progress(id, l) })
    running.set(id, run.child)
    const res = await run.done
    running.delete(id)
    try {
      if (!res.ok) throw new Error(res.error || `${agentSpec(defaultAgent()).name} did not finish`)
      const version = (b.model?.version ?? 0) + 1
      const model = modelFrom(extractJson(res.text) as Record<string, unknown>, version)
      saveModel(id, model)
      const diff = b.model ? diffModels(b.model, model) : null
      appendChange(id, {
        id: `c${Date.now()}`,
        at: model.updatedAt,
        kind: b.model ? 'rebuild' : 'build',
        trigger: ['by hand'],
        summary: b.model
          ? `Re-surveyed the whole project: ${diff!.items.length ? `${diff!.items.length} differences` : 'nothing differs'}.`
          : `First map: ${model.nodes.length} parts, ${model.edges.length} connections, ${model.watches.length} things watched.`,
        items: diff?.items.slice(0, 60) ?? [],
        touched: diff ? [...diff.touched] : [],
        version,
        ...(diff ? { added: diff.added, removed: diff.removed } : {}),
      })
      // The build is the baseline: fingerprint now, so the first check does not see
      // "everything moved" and immediately re-run Claude on what it just read.
      const fps = await fingerprintAll(model.watches)
      saveState(id, { fingerprints: fps.fingerprints, watchErrors: fps.errors, lastCheckAt: new Date().toISOString(), lastError: '' })
    } catch (e) {
      saveState(id, { lastError: `Build failed: ${(e as Error).message}` })
    } finally {
      setJob(id, null)
      changed(id)
    }
  }
  const p = queue.then(task, task)
  queue = p.catch(() => {})
  return p
}

async function fingerprintAll(watches: MapWatch[]): Promise<{ fingerprints: Record<string, string>; errors: Record<string, string> }> {
  const fingerprints: Record<string, string> = {}
  const errors: Record<string, string> = {}
  await Promise.all(
    watches.map(async (w) => {
      try {
        fingerprints[watchKey(w)] = await fingerprint(w)
      } catch (e) {
        errors[watchKey(w)] = (e as Error).message
      }
    }),
  )
  return { fingerprints, errors }
}

/**
 * The cheap loop, and Claude only if it found something. `force` runs the update even
 * when nothing moved — Refresh, when the user suspects the map is behind something the
 * watches cannot see.
 */
export async function check(id: string, force = false): Promise<void> {
  if (jobs.has(id)) return
  const b = load(id)
  if (!b?.model) return
  setJob(id, { kind: 'check', startedAt: new Date().toISOString(), line: 'Checking the watched sources…' })
  let fps: { fingerprints: Record<string, string>; errors: Record<string, string> }
  try {
    fps = await fingerprintAll(b.model.watches)
  } finally {
    setJob(id, null)
  }
  const moved = b.model.watches.filter((w) => {
    const k = watchKey(w)
    return fps.fingerprints[k] !== undefined && fps.fingerprints[k] !== b.state.fingerprints[k]
  })
  saveState(id, { watchErrors: fps.errors, lastCheckAt: new Date().toISOString() })
  if (!moved.length && !force) {
    changed(id)
    return
  }
  await update(id, moved, fps.fingerprints, force)
}

async function update(id: string, moved: MapWatch[], now: Record<string, string>, byHand: boolean): Promise<void> {
  if (jobs.has(id)) return
  setJob(id, { kind: 'update', startedAt: new Date().toISOString(), line: 'Waiting for Claude…' })
  const task = async () => {
    const b = load(id)
    if (!b?.model) return setJob(id, null)
    progress(id, 'Reading what changed…')
    const parts: string[] = []
    for (const w of moved) {
      const k = watchKey(w)
      if (w.kind === 'git') parts.push(await gitEvidence(w, b.state.fingerprints[k], now[k]!))
      else parts.push(`${w.kind} ${w.target}: ${b.state.fingerprints[k] ?? '(first seen)'} -> ${now[k]}`)
    }
    if (byHand) parts.push(`The owner asked for a refresh by hand. Besides the above, check the project's sources for anything the map no longer matches (last updated ${b.model.updatedAt}).`)
    const run = runClaude(updatePrompt(b.project, b.model, parts.join('\n\n') || '(nothing recorded)'), {
      timeoutMs: 15 * 60_000,
      onLine: (l) => progress(id, l),
    })
    running.set(id, run.child)
    const res = await run.done
    running.delete(id)
    try {
      if (!res.ok) throw new Error(res.error || `${agentSpec(defaultAgent()).name} did not finish`)
      const patch = extractJson(res.text) as { summary?: string; changes?: MapChangeItem[]; ops?: unknown[] }
      const { model, touched, added, removed } = applyOps(b.model, Array.isArray(patch.ops) ? patch.ops : [])
      const items = (Array.isArray(patch.changes) ? patch.changes : [])
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => ({
          text: c.text.slice(0, 400),
          ...(c.node && model.nodes.some((n) => n.id === cleanId(c.node)) ? { node: cleanId(c.node) } : {}),
          ...(c.impact && ['minor', 'notable', 'major'].includes(c.impact) ? { impact: c.impact } : {}),
        }))
      for (const c of items) if (c.node) touched.add(c.node)
      const opsLanded = Array.isArray(patch.ops) && patch.ops.length > 0
      if (opsLanded) {
        model.version = b.model.version + 1
        model.updatedAt = new Date().toISOString()
        saveModel(id, model)
      }
      appendChange(id, {
        id: `c${Date.now()}`,
        at: new Date().toISOString(),
        kind: 'update',
        trigger: byHand && !moved.length ? ['by hand'] : moved.map((w) => w.label || `${w.kind} ${w.target.replace(/^.*[\\/]/, '')}`),
        summary: String(patch.summary ?? '').slice(0, 800) || 'Updated.',
        items: items.slice(0, 40),
        touched: [...touched],
        version: opsLanded ? model.version : b.model.version,
        ...(added.size ? { added: [...added] } : {}),
        ...(removed.length ? { removed } : {}),
      })
      // Only now are the new fingerprints the baseline: a failed update retries next check.
      saveState(id, { fingerprints: { ...b.state.fingerprints, ...now }, lastError: '' })
    } catch (e) {
      saveState(id, { lastError: `Update failed: ${(e as Error).message}` })
    } finally {
      setJob(id, null)
      changed(id)
    }
  }
  const p = queue.then(task, task)
  queue = p.catch(() => {})
  return p
}

let ticker: NodeJS.Timeout | null = null

/** Every minute: any project whose interval has passed gets its cheap check. */
export function startMaps(send: Emit): () => void {
  emit = send
  const tick = () => {
    for (const s of listProjects()) {
      const b = load(s.project.id)
      if (!b?.model || jobs.has(s.project.id) || !b.project.pollMinutes) continue
      const last = b.state.lastCheckAt ? Date.parse(b.state.lastCheckAt) : 0
      if (Date.now() - last >= b.project.pollMinutes * 60_000) void check(s.project.id)
    }
  }
  const first = setTimeout(tick, 45_000)
  ticker = setInterval(tick, 60_000)
  return () => {
    clearTimeout(first)
    if (ticker) clearInterval(ticker)
    for (const c of running.values()) killTree(c)
    for (const c of asks.values()) killTree(c)
  }
}

// ---------------------------------------------------------------------------
// asking: a question about one part, answered where it was asked
// ---------------------------------------------------------------------------

const asks = new Map<string, ChildProcess>()

function neighbourhood(model: MapModel, nodeId: string | null): string {
  if (!nodeId) return ''
  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const node = byId.get(nodeId)
  if (!node) return ''
  const chain: string[] = []
  for (let p = node.parent ? byId.get(node.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) chain.unshift(p.name)
  const kids = model.nodes.filter((n) => n.parent === nodeId).map((n) => `- ${n.name} (${n.kind}): ${n.summary}`)
  const name = (id: string) => byId.get(id)?.name ?? id
  const out = model.edges.filter((e) => e.from === nodeId).map((e) => `- -> ${name(e.to)}${e.label ? ` (${e.label})` : ''}`)
  const inn = model.edges.filter((e) => e.to === nodeId).map((e) => `- <- ${name(e.from)}${e.label ? ` (${e.label})` : ''}`)
  return [
    `The part they are asking about: ${node.name} (${node.kind}), inside ${chain.join(' > ') || 'the top level'}.`,
    '```json',
    JSON.stringify(node),
    '```',
    kids.length ? `Its parts:\n${kids.join('\n')}` : '',
    out.length || inn.length ? `Its connections:\n${[...out, ...inn].join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function ask(projectId: string, nodeId: string | null, question: string, askId: string): void {
  const say = (kind: MapAskEvent['kind'], text: string) => emit('ember:map:ask', { askId, kind, text } satisfies MapAskEvent)
  const b = load(projectId)
  if (!b?.model) return say('error', 'This project has no map yet.')
  const node = nodeId ? b.model.nodes.find((n) => n.id === nodeId) : undefined
  const recent = b.changes
    .filter((c) => !nodeId || c.touched.includes(nodeId))
    .slice(-6)
    .map((c) => `- ${c.at.slice(0, 16).replace('T', ' ')}: ${c.summary}${c.items.filter((i) => !nodeId || i.node === nodeId).map((i) => ` ${i.text}`).join('')}`)
  const prompt = [
    `The owner is looking at the architecture map of "${b.project.name}" in their terminal app and has a question${node ? ` about one part of it` : ''}. Answer it directly, in a small popup: lead with the answer, markdown, as short as the question allows (usually under 200 words). No preamble, no offer to do more.`,
    `If the map is enough, answer from it. If not, look — the code, the git history, the hosting, the live site — with your read-only tools. You cannot change anything; if the answer is "this needs changing", say what and where, briefly, and that they can open a change session from the map.`,
    ``,
    `The project overview: ${b.model.overview}`,
    neighbourhood(b.model, nodeId),
    recent.length ? `Recent changes${node ? ' touching it' : ''}:\n${recent.join('\n')}` : '',
    `Every part on the map, for reference: ${b.model.nodes.map((n) => `${n.id} (${n.name})`).join(', ')}`,
    ``,
    `His question: ${question}`,
  ]
    .filter(Boolean)
    .join('\n')
  const cwd = node?.path && existsSync(node.path) && statSync(node.path).isDirectory() ? node.path : HOME
  const run = runClaude(prompt, { cwd, timeoutMs: 6 * 60_000, onLine: (l) => say('progress', l) })
  asks.set(askId, run.child)
  void run.done.then((res) => {
    asks.delete(askId)
    if (res.ok) say('done', res.text.trim())
    else say('error', res.error || 'No answer.')
  })
}

export function cancelAsk(askId: string): void {
  const c = asks.get(askId)
  if (c) killTree(c)
  asks.delete(askId)
}
