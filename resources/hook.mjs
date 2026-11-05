#!/usr/bin/env node
/**
 * Ember's Claude Code hook, where Windows has no curl.exe: hands the hook's JSON input
 * (stdin) to the bridge, which binds the tab to its session (SessionStart, a `/clear`
 * included). Claude Code runs it from Ember's settings file (src/main/bridge.ts,
 * writeSettings) as an `async` hook: it never waits on it, and nothing is printed back.
 *
 * Whatever goes wrong — no bridge (a `claude` outside Ember), Ember gone — this exits
 * quietly and Claude Code carries on exactly as it would without Ember.
 *
 * Hand-rolled like statusline.mjs: it runs with no node_modules beside it.
 */

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID
/** When Claude Code ran this: async hooks can land out of order. */
const STARTED = Date.now()

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => void main(Buffer.concat(chunks).toString('utf8')))

async function main(raw) {
  let input = null
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  if (!BRIDGE || !TOKEN || !TAB || !input || typeof input !== 'object') process.exit(0)
  try {
    await fetch(`${BRIDGE}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
      body: JSON.stringify({ tabId: TAB, at: STARTED, input }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    /* Ember is not there: Claude Code goes on as without it. */
  }
  process.exit(0)
}
