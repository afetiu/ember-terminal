#!/usr/bin/env node
/**
 * `desk` — Claude drives the desktop, from an Ember shell.
 *
 * A thin client: the work is done by the daemon Ember runs (resources/desk/desk.py),
 * reached over a loopback socket whose port and token the shell inherited from Ember.
 * Outside an Ember tab there is no port and no token, and the command says so — the
 * tool is part of the app, not a thing installed on the machine.
 *
 * `halt`, `resume` and `status` go to the bridge instead: they are Ember's decisions
 * (the Stop button in the sidebar is the same switch), and `halt` has to work when the
 * daemon is busy or gone.
 */
import { connect } from 'node:net'

const PORT = Number(process.env.EMBER_DESK_PORT || 0)
const TOKEN = process.env.EMBER_DESK_TOKEN || ''
const BRIDGE = process.env.EMBER_BRIDGE_URL || ''
const BRIDGE_TOKEN = process.env.EMBER_BRIDGE_TOKEN || ''
const TAB = process.env.EMBER_TAB_ID || ''

const argv = process.argv.slice(2)

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

async function bridge(path, body = {}) {
  const res = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ember-token': BRIDGE_TOKEN },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {
    json = { error: text }
  }
  if (!res.ok) throw new Error(json.error || `bridge ${res.status}`)
  return json
}

function call(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port: PORT })
    let data = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('desk: timed out'))
    }, timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ argv: args, token: TOKEN, tab: TAB })}\n`))
    sock.on('data', (chunk) => {
      data += chunk
      if (data.endsWith('\n')) sock.end()
    })
    sock.on('close', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error(data ? `desk: bad reply: ${data.slice(0, 200)}` : 'desk: connection closed'))
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function main() {
  if (!PORT || !TOKEN || !BRIDGE) fail('desk works only inside an Ember shell (it is part of the Ember app).', 2)

  const first = argv[0] ?? ''
  if (first === 'halt' || first === 'resume' || first === 'status' || first === 'daemon') {
    const verb = first === 'daemon' ? (argv[1] ?? 'status') : first
    const r = await bridge(`/desk/${verb === 'stop' ? 'stop' : verb === 'start' ? 'start' : verb}`)
    const s = r.state ?? r
    if (verb === 'status' || verb === 'start' || verb === 'stop') {
      const parts = [s.halted ? 'HALTED' : s.running ? 'running' : 'off']
      if (s.ready && s.ready !== 'ok') parts.push(`(${s.ready}${s.message ? `: ${s.message}` : ''})`)
      if (s.last?.label) parts.push(`· last: ${s.last.label}`)
      process.stdout.write(`${parts.join(' ')}\n`)
    } else {
      process.stdout.write(`${verb === 'halt' ? 'halted: computer use stopped until `desk resume`' : 'resumed'}\n`)
    }
    return
  }

  let reply
  try {
    reply = await call(argv)
  } catch (err) {
    // Nothing listening: ask Ember to bring the daemon up (it may be the first use, or the
    // Stop button killed it). Ember answers with the state, which says why if it cannot.
    let state
    try {
      state = (await bridge('/desk/start')).state
    } catch (e) {
      fail(`desk: ${e.message}`, 2)
    }
    if (state.halted) fail('HALTED: the Stop button in Ember was pressed. `desk resume` (or the Resume button) lifts it.', 3)
    if (!state.running) fail(`desk: computer use is unavailable (${state.ready}${state.message ? `: ${state.message}` : ''})`, 2)
    reply = await call(argv)
  }
  if (reply.out) process.stdout.write(`${String(reply.out).trimEnd()}\n`)
  process.exit(reply.ok ? 0 : 1)
}

main().catch((err) => fail(`desk: ${err.message}`))
