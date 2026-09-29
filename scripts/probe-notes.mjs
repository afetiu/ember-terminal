/**
 * The notes tab, exercised end to end.
 *
 * Opens a note tab, writes into it, waits out the autosave, and then checks the file on
 * disk — because the whole claim of this feature is that a note is an ordinary file that
 * Notepad could have written. Anything that verifies only the DOM would pass while the
 * disk stayed empty.
 *
 * Point EMBER_NOTES_DIR at a scratch folder before launching Ember, or this writes into
 * the real notes folder.
 *
 *   node scripts/probe-notes.mjs      (needs --remote-debugging-port=9222)
 */
import { readdirSync, readFileSync } from 'node:fs'

const PORT = Number(process.env['EMBER_CDP_PORT'] ?? 9222)
const DIR = process.env['EMBER_NOTES_DIR']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'))
if (!page) {
  console.error('No renderer target — launch Ember with --remote-debugging-port=%d', PORT)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const waiting = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result)
    waiting.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq
    waiting.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return `ERROR ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
  return r.result.value
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)})`}`)
}

console.log(`notes dir: ${DIR ?? '(default — Documents\\Ember Notes)'}\n`)

// The folder is the source of truth, so the test reads it rather than the app's list.
const filesBefore = DIR ? readdirSync(DIR) : []

await evaluate('window.__ember.openNotes()')
await sleep(1200)
check('note tab opened', await evaluate("!!document.querySelector('.ember-notes')"), true)
check('starts on the list', await evaluate("document.querySelector('.ember-notes')?.dataset.mode"), 'list')

await evaluate("document.querySelector('.ember-notes-new').click()")
await sleep(900)
check('new note switches to editor', await evaluate("document.querySelector('.ember-notes')?.dataset.mode"), 'edit')
check('editor is focused', await evaluate("document.activeElement?.className"), (c) => String(c).includes('ember-notes-area'))

const BODY = 'Probe note\n\nSecond line written by probe-notes.'
await evaluate(
  `(() => { const a = document.querySelector('.ember-notes-area'); a.value = ${JSON.stringify(BODY)}; a.dispatchEvent(new Event('input')); })()`,
)
// The autosave debounce is 400ms; give it room without giving it a pass.
await sleep(1400)

check('tab title follows first line', await evaluate("document.querySelector('.ember-card.is-active .ember-card-title')?.textContent"), (t) =>
  String(t).includes('Probe note'),
)

if (DIR) {
  const added = readdirSync(DIR).filter((f) => !filesBefore.includes(f))
  check('exactly one file created', added.length, 1)
  const file = added[0]
  if (file) {
    check('named after the title', file, 'Probe note.md')
    check('content on disk matches', readFileSync(`${DIR}/${file}`, 'utf8'), BODY)
  }
} else {
  console.log('  skip  disk checks (set EMBER_NOTES_DIR to enable)')
}

// Escape goes back to the list, and the note should be there.
await evaluate(
  "document.querySelector('.ember-notes-area').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
)
await sleep(900)
check('escape returns to list', await evaluate("document.querySelector('.ember-notes')?.dataset.mode"), 'list')
check('note appears in list', await evaluate("[...document.querySelectorAll('.ember-notes-title')].map(e=>e.textContent).join('|')"), (t) =>
  String(t).includes('Probe note'),
)

console.log(`\n  ${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`}`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
