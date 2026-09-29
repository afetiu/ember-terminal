#!/usr/bin/env node
/**
 * Ember's status line for Claude Code.
 *
 * Claude Code runs this after every update with a JSON snapshot of the session on
 * stdin — model, context window, cost, the plan's rate limits — and shows whatever it
 * prints under the prompt. Two things happen here: the snapshot is handed to Ember's
 * bridge, so the tab's card in the sidebar can show context and cost; and a line is
 * printed, either the user's own status line if they had one configured (it is run
 * unchanged, with the same stdin) or Ember's.
 *
 * Reached through a settings file the `claude` shim passes as `--settings`, so it only
 * ever applies to sessions inside Ember. The environment it needs came down the same
 * chain as the panel's: pty, shell, claude, here. Hand-rolled like mcp-panel.mjs, and
 * for the same reason — it has to run with no node_modules beside it.
 */

import { spawn } from 'node:child_process'

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID
const INNER = process.env.EMBER_STATUSLINE_INNER

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => void main(Buffer.concat(chunks).toString('utf8')))

async function main(raw) {
  let data = {}
  try {
    data = JSON.parse(raw)
  } catch {
    /* A line is still owed; it will just be short. */
  }
  const reported = report(data)
  const line = INNER ? await inner(raw) : render(data)
  process.stdout.write(line)
  // Claude Code cancels this script when the next update arrives, so the report must
  // not be what the line waits on — but give it a moment to land before exiting.
  await Promise.race([reported, sleep(1500)])
  process.exit(0)
}

async function report(data) {
  if (!BRIDGE || !TOKEN || !TAB) return
  try {
    await fetch(`${BRIDGE}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
      body: JSON.stringify({ tabId: TAB, status: data }),
      signal: AbortSignal.timeout(1200),
    })
  } catch {
    /* The line still prints; the card just stays as it was. */
  }
}

/** Ember's own line: only the parts that are present, separated quietly. */
function render(d) {
  const parts = []
  const model = d.model?.display_name ?? d.model?.id
  if (model) parts.push(String(model))
  const ctx = d.context_window?.used_percentage
  if (isNum(ctx)) parts.push(`ctx ${Math.round(ctx)}%`)
  const cost = d.cost?.total_cost_usd
  if (isNum(cost)) parts.push(`$${cost < 10 ? cost.toFixed(2) : cost.toFixed(1)}`)
  const five = d.rate_limits?.five_hour?.used_percentage
  if (isNum(five)) parts.push(`5h ${Math.round(five)}%`)
  const week = d.rate_limits?.seven_day?.used_percentage
  if (isNum(week)) parts.push(`wk ${Math.round(week)}%`)
  return parts.join('  ·  ')
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** The user's own status line, run as they configured it, fed the same JSON. */
function inner(raw) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(out)
    }
    try {
      const child = spawn(INNER, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      child.stdout.on('data', (c) => (out += String(c)))
      child.on('close', finish)
      child.on('error', finish)
      child.stdin.on('error', () => {})
      child.stdin.end(raw)
      setTimeout(() => {
        child.kill()
        finish()
      }, 5000).unref()
    } catch {
      finish()
    }
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms).unref())
}
