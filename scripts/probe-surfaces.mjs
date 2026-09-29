/**
 * Bare note and todo tabs, switched between: does each show its content on arrival?
 *
 * A tab with no shell in it (the todo list opened from the empty stage, a note opened
 * the same way) has none of the terminal's own triggers — no output, no fit — so it is
 * the case most likely to be left blank by a step that the shell path happens to cover.
 * Each switch dumps the computed styles of the tab and its surface, and a screenshot.
 *
 *   node scripts/probe-surfaces.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9385
const OUT = join(process.env.TEMP ?? '.', 'ember-shots')
mkdirSync(OUT, { recursive: true })
const EMBER_HOME = join(process.env.TEMP ?? '.', `ember-probe-${basename(process.argv[1])}`)
mkdirSync(EMBER_HOME, { recursive: true })
const NOTES = join(EMBER_HOME, 'notes')
mkdirSync(NOTES, { recursive: true })
writeFileSync(join(NOTES, 'Probe note.md'), 'Probe note\n\nSome words that must be visible on arrival.\n')
writeFileSync(join(NOTES, 'Todo.md'), '- [ ] An item that must be visible\n- [ ] Another one\n')
const userCfg = join(homedir(), '.ember', 'config.json')
const cfg = existsSync(userCfg) ? JSON.parse(readFileSync(userCfg, 'utf8')) : {}
writeFileSync(join(EMBER_HOME, 'config.json'), JSON.stringify(cfg, null, 2))

const child = spawn('./node_modules/electron/dist/electron.exe', ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, EMBER_HOME, EMBER_NOTES_DIR: NOTES, EMBER_PROBE_INACTIVE: '1' },
})

async function findPage() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.includes('realtime'))
      if (p) return p
    } catch {
      /* not up */
    }
    await sleep(300)
  }
  throw new Error('no devtools target')
}
const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (p) {
    pending.delete(m.id)
    p(m)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++seq, res)
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
await send('Runtime.enable')
await send('Page.enable')
for (let i = 0; i < 100; i++) {
  if (await ev(`typeof window.__ember !== 'undefined'`)) break
  await sleep(200)
}
await sleep(1500)
await ev(`window.ember.window.toggleMaximize()`)
await sleep(4000)

const state = (label) =>
  ev(`(() => {
    const all = [...document.querySelectorAll('.ember-group')].map((e) => ({ cls: e.className, op: getComputedStyle(e).opacity, vis: getComputedStyle(e).visibility, z: getComputedStyle(e).zIndex, surf: e.querySelector('.ember-todo, .ember-notes')?.className ?? '', panes: e.querySelectorAll('.ember-slot').length }))
    const actives = [...document.querySelectorAll('.ember-group.is-active')]
    const g = actives[actives.length - 1]
    if (!g) return { label: ${JSON.stringify(label)}, active: null, all }
    const cs = getComputedStyle(g)
    const panes = g.querySelector('.ember-group-panes')
    const surf = g.querySelector('.ember-todo, .ember-notes')
    const inner = surf?.querySelector('.ember-tasks, .ember-notes-area, .ember-notes-rows')
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    return {
      label: ${JSON.stringify(label)},
      all,
      groupId: g.dataset.id ?? g.id ?? null,
      opacity: cs.opacity, transform: cs.transform, visibility: cs.visibility, display: cs.display, box: box(g),
      panesDisplay: panes ? getComputedStyle(panes).display : null, panesClass: panes?.className,
      surface: surf?.className ?? null, surfaceBox: box(surf), surfaceDisplay: surf ? getComputedStyle(surf).display : null,
      innerBox: box(inner), innerText: (inner?.textContent ?? '').slice(0, 60), innerRows: inner?.children?.length ?? null,
      textareaValue: surf?.querySelector('textarea')?.value?.slice(0, 40) ?? null,
      noteMode: surf?.dataset?.mode ?? null,
      editBox: box(surf?.querySelector('.ember-notes-edit')), editView: surf?.querySelector('.ember-notes-edit')?.dataset?.view ?? null,
      editDisplay: surf?.querySelector('.ember-notes-edit') ? getComputedStyle(surf.querySelector('.ember-notes-edit')).display : null,
      areaBox: box(surf?.querySelector('.ember-notes-area')), areaDisplay: surf?.querySelector('.ember-notes-area') ? getComputedStyle(surf.querySelector('.ember-notes-area')).display : null,
      tasksBox: box(surf?.querySelector('.ember-tasks')), listBox: box(surf?.querySelector('.ember-notes-list')),
      barBox: box(surf?.querySelector('.ember-notes-bar')), headBox: box(surf?.querySelector('.ember-notes-head')),
      children: surf ? [...surf.children].map((c) => c.className + ':' + getComputedStyle(c).display + ':' + Math.round(c.getBoundingClientRect().height)) : null,
    }
  })()`)

const log = []
// Everything closed: the empty stage.
for (const g of await ev(`window.__ember.groups()`)) await ev(`window.__ember.closeTab(${JSON.stringify(g.id)})`)
await sleep(800)
// A bare todo tab from nothing, then a bare note tab from the notes list.
await ev(`window.__ember.openTodo()`)
await sleep(1200)
log.push(await state('todo fresh'))
await shot('10-bare-todo-fresh')
await ev(`window.__ember.newTab()`)
await sleep(2500)
await ev(`window.__ember.openNotes('Probe note.md')`)
await sleep(1200)
log.push(await state('note over shell fresh'))
await shot('13-note-fresh')
const groups = await ev(`window.__ember.groups()`)
const todoTab = groups[0].id
const noteTab = groups[1].id
// Switch back to the todo tab, then to the note, then back again.
await ev(`window.__ember.activate(${JSON.stringify(todoTab)})`)
await sleep(1200)
log.push(await state('todo after switch'))
await shot('11-bare-todo-after-switch')
await ev(`window.__ember.activate(${JSON.stringify(noteTab)})`)
await sleep(1200)
log.push(await state('note after switch'))
await shot('12-note-after-switch')
await ev(`window.__ember.activate(${JSON.stringify(todoTab)})`)
await sleep(1200)
log.push(await state('todo after second switch'))

for (const s of log) console.log(JSON.stringify(s))
ws.close()
child.kill()
