#!/usr/bin/env node
/**
 * `ember` — the app, from its own shells.
 *
 * Every action Ember's chrome offers is a row in one table in the renderer (App.ts,
 * `commandTable`): the palette lists that table, and this command runs it. A button is
 * a way to find the command; the command is the thing. So `ember split right`,
 * `ember rename api`, `ember panel hide`, `ember orch "run the tests in tab 2"` do
 * exactly what the click would, from the tab that typed them — and from a Claude
 * session in that tab, which is the point: the model reaches the app with the same
 * words you do.
 *
 * The words go to the running Ember over the bridge the tab already has
 * (EMBER_BRIDGE_URL, the token, the tab id). Outside an Ember tab only `ember set` and
 * `ember get` work, because they edit ~/.ember/config.json directly and the running
 * app's file watcher applies the change.
 *
 * Runs under system node where there is one, else under Ember's own binary as node.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID
const HOME = process.env.EMBER_HOME || join(homedir(), '.ember')
const CONFIG = join(HOME, 'config.json')

const STATIC_HELP = `ember <command> [args]         Ember, from the shell

  ember                        this list, from the running app (every palette entry)
  ember new [dir]              new session, in a folder
  ember split right|down       split the tab
  ember close                  close the focused pane
  ember rename <name>          name the tab
  ember focus <n|name>         switch to a tab
  ember list                   the open tabs
  ember panel [show|hide]      the visualisation panel
  ember visualize              ask the Claude in this tab to draw what it just said
  ember orch [text]            open the orchestrator, or hand it something
  ember theme [name]           apply a theme
  ember settings [tab]         open Settings (look, motion, todo, claude, behaviour)
  ember set <path> <value>     write one setting, e.g. ember set window.opacity 60
  ember get <path>             read one setting
  ember diag                   the watchdog log (~/.ember/diag.log), newest last

notes, note and todo are commands of their own.`

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

/** "60" → 60, "true" → true, '{"a":1}' → object, anything else stays a string. */
function parseValue(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (/^[[{"]/.test(raw)) {
    try {
      return JSON.parse(raw)
    } catch {
      /* a string that happens to start like JSON */
    }
  }
  return raw
}

function readConfig() {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {}
  } catch (err) {
    fail(`ember: ${CONFIG} is not valid JSON (${err.message})`)
  }
}

function setPath(obj, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  let cur = obj
  for (const k of keys) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
    cur = cur[k]
  }
  cur[last] = value
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
}

const words = process.argv.slice(2)
const verb = words[0]

if (verb === '--help' || verb === '-h' || (verb === 'help' && !BRIDGE)) {
  console.log(STATIC_HELP)
  process.exit(0)
}

if (verb === 'set') {
  const [, path, ...rest] = words
  if (!path || !rest.length) fail('usage: ember set <path> <value>   e.g. ember set window.opacity 60', 2)
  const cfg = readConfig()
  const value = parseValue(rest.join(' '))
  setPath(cfg, path, value)
  mkdirSync(HOME, { recursive: true })
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  console.log(`${path} = ${JSON.stringify(value)}`)
  process.exit(0)
}

if (verb === 'diag') {
  const file = join(HOME, 'diag.log')
  if (!existsSync(file)) {
    console.log('nothing logged yet (' + file + ')')
    process.exit(0)
  }
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const n = Number(words[1]) || 30
  console.log(lines.slice(-n).join('\n'))
  process.exit(0)
}

if (verb === 'get') {
  const path = words[1]
  if (!path) fail('usage: ember get <path>', 2)
  const v = getPath(readConfig(), path)
  if (v === undefined) fail(`${path}: not set`)
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  process.exit(0)
}

if (!BRIDGE || !TOKEN) {
  fail(`ember: not inside an Ember tab, so there is no app to talk to.\n\n${STATIC_HELP}`)
}

let res
try {
  res = await fetch(`${BRIDGE}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
    body: JSON.stringify({ words, tabId: TAB ?? '' }),
  })
} catch (err) {
  fail(`ember: could not reach Ember at ${BRIDGE} (${err.message})`)
}
const body = await res.json().catch(() => ({}))
if (!res.ok || body.error) fail(`ember: ${body.error ?? `HTTP ${res.status}`}`)
if (body.result) console.log(body.result)
