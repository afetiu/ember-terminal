#!/usr/bin/env node
/**
 * Ember's Claude Code hook: how a Claude session in a tab tells the canvas what it is doing
 * and asks it what the person wants, with nothing read off its screen.
 *
 * Codex runs the same script (its hooks take Claude Code's shape: the same events, the
 * same PermissionRequest decision), handed to it by the shim's `-c hooks.â€¦` overrides once
 * the person has trusted them in Codex. EMBER_SESSION_AGENT says which agent is asking.
 *
 * Claude Code runs this for the events Ember's settings file lists (src/main/bridge.ts,
 * writeSettings), with the hook's JSON input on stdin. It is handed to the bridge as it
 * is. For most events that is all: they are `async` hooks, Claude never waits on them.
 *
 * `PermissionRequest` is the one that answers. The bridge holds the request until the
 * person answers Ember's card (a tool, a question, a plan), then gives back the hook
 * output to print. Claude Code shows its own dialog meanwhile (it runs these hooks beside
 * its dialog, not before it), and the answer from here resolves that dialog.
 *
 * Whatever goes wrong — no bridge (a `claude` outside Ember), Ember gone, no canvas on
 * the tab — this exits with no output, and Claude Code carries on exactly as it would
 * without Ember: its own dialog stays up for the person to answer in the CLI view.
 *
 * Hand-rolled like statusline.mjs: it runs with no node_modules beside it.
 */

const BRIDGE = process.env.EMBER_BRIDGE_URL
const TOKEN = process.env.EMBER_BRIDGE_TOKEN
const TAB = process.env.EMBER_TAB_ID
/** When Claude Code ran this: async hooks can land out of order, and the canvas sorts them by it. */
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
  const blocking = input.hook_event_name === 'PermissionRequest'
  try {
    const res = await fetch(`${BRIDGE}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ember-token': TOKEN },
      body: JSON.stringify({ tabId: TAB, at: STARTED, agent: process.env.EMBER_SESSION_AGENT || 'claude', input }),
      // A card waits on a person; Claude Code's own hook timeout is the limit there.
      ...(blocking ? {} : { signal: AbortSignal.timeout(3000) }),
    })
    if (blocking && res.ok) {
      const body = await res.json()
      if (body && body.output && typeof body.output === 'object') process.stdout.write(JSON.stringify(body.output))
    }
  } catch {
    /* Ember is not there: Claude Code goes on as without it. */
  }
  process.exit(0)
}
