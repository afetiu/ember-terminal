/**
 * Native canvas, Phases 2 and 3 (docs/specs/canvas-native.md): Ember's own composer — the
 * `/` and `@` menus, pictures pasted and dropped, the queue with Send now and ×, `!` in the
 * tab's shell, history — and the cards for what Claude Code asks: a tool permission (with
 * "don't ask again" and a diff), AskUserQuestion, ExitPlanMode and an MCP elicitation.
 *
 * Two runs of a dev Ember, each with its own EMBER_HOME (CDP ports 9443/9444 unless
 * PROBE_PORT is set):
 *   1. the stand-in (scripts/fake-claude.mjs): every feature end to end, with what reached
 *      Claude Code read back from the stand-in's log.
 *   2. the real `claude`, `--model haiku`: `/context` renders, and a red square pasted as a
 *      picture comes back as "red".
 *
 * Keys go to Ember's own input box and cards only. Nothing is typed into a terminal running claude.
 *
 *   npm run build; node scripts/probe-native-composer.mjs [out-dir] [--fake-only]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
const args = process.argv.slice(2)
const OUT = args.find((a) => !a.startsWith('--')) ?? join(process.env.TEMP ?? '.', 'ember-native-composer-shots')
const FAKE_ONLY = args.includes('--fake-only')
const PORT = Number(process.env.PROBE_PORT) || 9443
mkdirSync(OUT, { recursive: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
}

/** A dev Ember with native mode on, driven over CDP. */
async function ember(name, port, env) {
  const home = join(process.env.TEMP ?? '.', `ember-probe-composer-${name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ agent: { onboarded: true }, brain: { sync: false }, canvas: { native: true } }))
  const child = spawn(join(REPO, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${port}`], {
    cwd: REPO,
    stdio: 'ignore',
    env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_BOUNDS: '1280x800', EMBER_PROBE_INACTIVE: '1', ...env },
  })
  let target
  for (let i = 0; i < 60 && !target; i++) {
    await wait(500)
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    pending.get(m.id)?.(m.result ?? m.error)
    pending.delete(m.id)
  })
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${file}.png`), Buffer.from(r.data, 'base64'))
    return join(OUT, `${file}.png`)
  }
  const key = (k, code, vk, modifiers = 0, text) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }).then(() =>
      send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    )
  const enter = (modifiers = 0) => key('Enter', 'Enter', 13, modifiers, '\r')
  const esc = () => key('Escape', 'Escape', 27)
  const digit = (n) => key(String(n), `Digit${n}`, 48 + n, 0, String(n))
  const typeText = (text) => send('Input.insertText', { text })
  const focusInput = () => ev(`document.querySelector('.loom-native-input').focus()`)
  /** Type into Ember's own input, then Enter. */
  const say = async (text) => {
    await focusInput()
    await typeText(text)
    await enter()
  }
  const until = async (fn, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await wait(150)
    }
    return null
  }
  const close = () => {
    ws.close()
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await wait(5000)
  return { ev, shot, key, enter, esc, digit, typeText, focusInput, say, until, close, home }
}

async function claudeTab(e, cwd) {
  const first = await e.ev('window.__ember.activeTab()')
  const tab = await e.ev(`window.__ember.newClaude(${JSON.stringify(cwd)})`)
  await e.ev(`window.__ember.closeTab(${JSON.stringify(first)})`)
  await e.ev(`window.__ember.activate(${JSON.stringify(tab)})`)
  return tab
}

const loom = (e, tab) => e.ev(`window.__ember.loom(${JSON.stringify(tab)})`)

/** A solid square as a PNG File, made in the page, handed to the input as a paste (or a drop on the frame). */
const picture = (how, color = '#e01010', size = 16) => `(async () => {
  const c = document.createElement('canvas'); c.width = c.height = ${size}
  const g = c.getContext('2d'); g.fillStyle = '${color}'; g.fillRect(0, 0, ${size}, ${size})
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'square.png', { type: 'image/png' }))
  ${
    how === 'paste'
      ? `document.querySelector('.loom-native-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))`
      : `document.querySelector('.loom-frame-box').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))`
  }
  return true
})()`

const toastSeen = (e, re) => e.ev(`[...document.querySelectorAll('*')].some((n) => n.childElementCount === 0 && ${re}.test(n.textContent))`)
const clearInput = (e) => e.ev(`(() => { const i = document.querySelector('.loom-native-input'); i.value = ''; i.dispatchEvent(new Event('input')); return true })()`)
/** Lines the stand-in read, parsed. */
const logLines = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l)) : [])

// ---------------------------------------------------------------- 1. the stand-in

{
  const log = join(process.env.TEMP ?? '.', `ember-fake-claude-composer-${PORT}.log`)
  rmSync(log, { force: true })
  const folder = join(process.env.TEMP ?? '.', 'ember-native-composer-fake')
  mkdirSync(folder, { recursive: true })
  const e = await ember('fake', PORT, { EMBER_CLAUDE_BIN: join(REPO, 'scripts', 'fake-claude.mjs'), FAKE_CLAUDE_LOG: log })
  const replied = (re, ms = 10000) =>
    e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && re.test(l.text) ? l : null
    }, ms)
  const users = () => logLines(log).filter((l) => l.in === 'user')
  const answers = () => logLines(log).filter((l) => l.in === 'control_response')
  const controls = (sub) => logLines(log).filter((l) => l.in === 'control_request' && l.subtype === sub)
  let tab
  try {
    tab = await claudeTab(e, folder)
    const ready = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && l.native.commands > 0 ? l : null
    }, 15000)
    check('stand-in comes up with its commands', !!ready, ready ? `${ready.native.commands} commands` : '')

    // ---- `/` menu
    await e.focusInput()
    await e.typeText('/')
    const menu = await e.until(async () => (await loom(e, tab))?.native?.menu, 3000)
    check('/ opens the command menu', menu?.kind === 'slash' && menu.items.includes('/compact') && menu.items.includes('/context'), JSON.stringify(menu?.items.slice(0, 6)))
    check('TUI-only commands are offered (for the CLI view)', !!menu?.items.includes('/login'))
    console.log('      shots:', await e.shot('composer-slash'))
    await e.typeText('cont')
    const filtered = await e.until(async () => {
      const m = (await loom(e, tab))?.native?.menu
      return m?.items[0] === '/context' ? m : null
    }, 2000)
    check('typing filters the menu', !!filtered, JSON.stringify(filtered?.items))
    await e.key('ArrowDown', 'ArrowDown', 40)
    await e.key('ArrowUp', 'ArrowUp', 38)
    await e.enter()
    const ctxReply = await replied(/Context Usage/)
    check('Enter on /context runs it, the answer is drawn', !!ctxReply)
    check('/context reached Claude Code as a plain message', users().some((u) => u.content === '/context'))
    console.log('      shots:', await e.shot('composer-context'))

    await e.focusInput()
    await e.typeText('/')
    const after = await e.until(async () => (await loom(e, tab))?.native?.menu, 3000)
    check('commands bound to the terminal (system/init) are left out', !!after && !after.items.includes('/fake-terminal-only'))
    await e.esc()
    check('Esc closes the menu', !(await loom(e, tab))?.native?.menu)
    await clearInput(e)

    await e.say('/login')
    await wait(300)
    check('/login says it opens in the CLI view, and is not sent', !!(await toastSeen(e, /login opens in the CLI view/)) && !users().some((u) => u.content === '/login'))
    await clearInput(e)

    // ---- `@` files
    await e.focusInput()
    await e.typeText('look at @mai')
    const files = await e.until(async () => {
      const m = (await loom(e, tab))?.native?.menu
      return m?.kind === 'file' ? m : null
    }, 3000)
    check('@ asks Claude Code for files (file_suggestions)', !!files && controls('file_suggestions').some((c) => c.request.query === 'mai'), JSON.stringify(files?.items))
    console.log('      shots:', await e.shot('composer-files'))
    await e.enter()
    const val = await e.ev(`document.querySelector('.loom-native-input').value`)
    check('Enter inserts @path', val === 'look at @src\\main.ts ', JSON.stringify(val))
    await clearInput(e)

    // ---- pictures
    await e.ev(picture('paste'))
    await e.ev(picture('paste', '#1060e0'))
    const two = await e.until(async () => ((await loom(e, tab))?.native?.attachments === 2 ? true : null), 3000)
    check('Ctrl+V with an image attaches it (twice)', !!two)
    const thumbs = await e.ev(`document.querySelectorAll('.loom-attach.has-items .loom-attach-item img').length`)
    check('thumbnails above the input', thumbs === 2, String(thumbs))
    console.log('      shots:', await e.shot('composer-attach'))
    await e.ev(`document.querySelector('.loom-attach-item:last-child .loom-attach-x').click()`)
    const one = await e.until(async () => ((await loom(e, tab))?.native?.attachments === 1 ? true : null), 2000)
    check('× takes a picture back', !!one)
    await e.ev(`(() => { const i = document.querySelector('.loom-native-input'); i.focus(); return true })()`)
    const textPasted = await e.ev(`(() => {
      const i = document.querySelector('.loom-native-input'); const dt = new DataTransfer(); dt.setData('text/plain', 'plain words')
      const ok = i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return ok
    })()`)
    check('text paste stays text (not taken as a picture)', textPasted === true && (await loom(e, tab))?.native?.attachments === 1)
    await e.say('what color is this?')
    const imgReply = await replied(/I see 1 image \(image\/png/)
    check('the picture reaches Claude Code as a base64 image block', !!imgReply && users().some((u) => Array.isArray(u.content) && u.content.some((b) => b.type === 'image' && b.media_type === 'image/png')))
    const turnThumb = await e.ev(`document.querySelectorAll('.loom-turn .loom-thumbs img').length`)
    check('the sent picture shows in the turn', turnThumb >= 1, String(turnThumb))

    await e.ev(picture('drop'))
    const dropped = await e.until(async () => ((await loom(e, tab))?.native?.attachments === 1 ? true : null), 3000)
    check('an image file dropped on the tab attaches it', !!dropped)
    await e.focusInput()
    await e.key('Backspace', 'Backspace', 8)
    check('Backspace on an empty box removes the last picture', (await loom(e, tab))?.native?.attachments === 0)

    // ---- shown at once, once
    await e.focusInput()
    await e.typeText('hello immediate')
    await e.enter()
    const early = await e.ev(`document.querySelector('.loom-flow').innerText.includes('hello immediate')`)
    check('the message shows in the turn at once', early === true)
    await replied(/You said: hello immediate/)
    const times = await e.ev(`[...document.querySelectorAll('.loom-ask-text')].filter((n) => n.textContent === 'hello immediate').length`)
    check('and once only, when the echo arrives', times === 1, String(times))

    // ---- queue, ×, send now
    await e.say('slow please')
    await e.until(async () => ((await loom(e, tab))?.native?.live.length > 30 ? true : null), 5000)
    await e.say('queued one')
    await e.say('queued two')
    const q2 = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.queue.length === 2 ? l : null
    }, 3000)
    check('messages sent while working wait as queued cards', !!q2 && (await e.ev(`document.querySelectorAll('.loom-native-queue .loom-queue-item').length`)) === 2)
    check('a queued message is not in the turn yet', !(await e.ev(`document.querySelector('.loom-flow').innerText.includes('queued one')`)))
    console.log('      shots:', await e.shot('composer-queue'))
    await e.ev(`[...document.querySelectorAll('.loom-native-queue .loom-queue-item')].find((n) => n.textContent.includes('queued two')).querySelector('[data-q="x"]').click()`)
    const q1 = await e.until(async () => ((await loom(e, tab))?.native?.queue.length === 1 ? true : null), 3000)
    check('× cancels a queued message (cancel_async_message)', !!q1 && controls('cancel_async_message').length === 1)
    await e.ev(`document.querySelector('.loom-native-queue [data-q="now"]').click()`)
    const sentNow = await replied(/You said: queued one/, 12000)
    check('Send now interrupts and the queued message runs', !!sentNow && controls('interrupt').some((c) => !c.request.cancel_queued))
    check('queued two never ran', !users().some((u) => u.content === 'queued two') || !(await e.ev(`document.querySelector('.loom-flow').innerText.includes('You said: queued two')`)))

    // ---- Esc gives the queue back
    await e.say('slow again')
    await e.until(async () => ((await loom(e, tab))?.native?.live.length > 30 ? true : null), 5000)
    await e.say('restore me')
    await e.until(async () => ((await loom(e, tab))?.native?.queue.length === 1 ? true : null), 3000)
    await e.esc()
    const restored = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && l.native.queue.length === 0 ? l : null
    }, 8000)
    check('Esc interrupts with the queue cancelled', !!restored && controls('interrupt').some((c) => c.request.cancel_queued === true))
    check('and the queued text comes back into the input', restored?.native?.input === 'restore me', JSON.stringify(restored?.native?.input))
    await clearInput(e)

    // ---- history, Shift+Enter
    await e.focusInput()
    await e.key('ArrowUp', 'ArrowUp', 38)
    const recalled = await e.ev(`document.querySelector('.loom-native-input').value`)
    check('Up on an empty box recalls the last message', recalled === 'restore me', JSON.stringify(recalled))
    await e.key('ArrowUp', 'ArrowUp', 38)
    const older = await e.ev(`document.querySelector('.loom-native-input').value`)
    check('Up again goes further back', older === 'slow again', JSON.stringify(older))
    await clearInput(e)
    await e.typeText('line one')
    await e.enter(8)
    await e.typeText('line two')
    const multi = await e.ev(`document.querySelector('.loom-native-input').value`)
    check('Shift+Enter is a newline', multi === 'line one\nline two', JSON.stringify(multi))
    await clearInput(e)

    // ---- `!` in the shell
    await e.say('!Write-Output "bang-$(6*7)"')
    const banged = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.bangContext === 2 ? l : null
    }, 20000)
    check('!command runs in the tab shell and its output shows in the turn', !!banged && /bang-42/.test(banged.text), banged ? JSON.stringify(banged.text.slice(-80)) : '')
    check('!command is not sent to Claude', !users().some((u) => JSON.stringify(u.content).includes('Write-Output') && !JSON.stringify(u.content).includes('bash-input')))
    console.log('      shots:', await e.shot('composer-bang'))
    await e.say('what did it print')
    const bangReply = await replied(/I saw your shell/)
    const carried = users().find((u) => Array.isArray(u.content) && u.content.some((b) => b.type === 'text' && b.text?.startsWith('<bash-input>')))
    check(
      'the next message carries <bash-input>/<bash-stdout> to Claude',
      !!bangReply && !!carried && carried.content.some((b) => /^<bash-stdout>bang-42/.test(b.text ?? '')),
      carried ? JSON.stringify(carried.content.map((b) => b.text?.slice(0, 40))) : ''
    )

    // ---- Phase 3: permission
    await e.say('ask me first')
    const perm = await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.[0] === 'tool' ? true : null), 5000)
    const card = await e.ev(`document.querySelector('.loom-ask-card')?.innerText ?? ''`)
    check('permission card: tool, command, reason', !!perm && /Bash/.test(card) && /npm test -- --watch=false/.test(card) && /not in your allow list/.test(card))
    check("permission card offers \"don't ask again\" from the suggestion", /don't ask again for Bash\(npm test:\*\)/.test(card), JSON.stringify(card.slice(0, 200)))
    check('the keyboard is on the card', await e.ev(`!!document.activeElement?.closest('.loom-ask-card')`))
    console.log('      shots:', await e.shot('asks-permission'))
    await e.digit(2)
    const always = await replied(/you said allow always/)
    const ansAlways = answers().at(-1)?.response
    check('2 = allow, echoing permission_suggestions in updatedPermissions', !!always && ansAlways?.updatedPermissions?.[0]?.rules?.[0]?.ruleContent === 'npm test:*')

    await e.say('ask quietly')
    await e.until(async () => ((await loom(e, tab))?.native?.asks === 1 ? true : null), 5000)
    const quiet = await e.ev(`!!document.querySelector('.loom-ask-card button[data-a="always"]')`)
    check('no "always" when suppress_always_allow_rule', quiet === false)
    // Numbered as shown, as Claude Code numbers them: without "always", No is 2.
    await e.digit(2)
    await replied(/you said deny/)
    check('2 (No, when there is no always) = deny, stopping the turn', answers().at(-1)?.response?.behavior === 'deny' && answers().at(-1)?.response?.interrupt === true)

    await e.say('ask again')
    await e.until(async () => ((await loom(e, tab))?.native?.asks === 1 ? true : null), 5000)
    await e.ev(`document.querySelector('.loom-ask-card-say').focus()`)
    await e.typeText('use pnpm instead')
    await e.enter()
    const told = await replied(/use pnpm instead/)
    check('deny with a message', !!told && answers().at(-1)?.response?.behavior === 'deny' && !answers().at(-1)?.response?.interrupt)

    await e.say('ask once more')
    await e.until(async () => ((await loom(e, tab))?.native?.asks === 1 ? true : null), 5000)
    await wait(200)
    await e.enter()
    check('Enter = allow', !!(await replied(/ask once more[\s\S]*you said allow/)) || answers().at(-1)?.response?.behavior === 'allow')

    await e.say('edit please')
    await e.until(async () => ((await loom(e, tab))?.native?.asks === 1 ? true : null), 5000)
    const diff = await e.ev(`document.querySelectorAll('.loom-ask-card .is-diff .del, .loom-ask-card .is-diff .ins').length`)
    const editAlways = await e.ev(`document.querySelector('.loom-ask-card button[data-a="always"]')?.textContent ?? ''`)
    check('Edit card shows the file and a diff', diff >= 4 && /main\.ts/.test(await e.ev(`document.querySelector('.loom-ask-card').innerText`)), String(diff))
    check('Edit card offers "allow all edits this session"', /allow all edits this session/.test(editAlways), editAlways)
    console.log('      shots:', await e.shot('asks-edit'))
    await e.esc()
    const escDenied = await replied(/edit deny/)
    check('Esc = deny', !!escDenied)

    // ---- AskUserQuestion
    await e.say('question time')
    await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.[0] === 'question' ? true : null), 5000)
    const chips = await e.ev(`document.querySelectorAll('.loom-ask-card .loom-ask-chip').length`)
    check('question card: the options as chips', chips === 5, String(chips))
    console.log('      shots:', await e.shot('asks-question'))
    await wait(150)
    await e.digit(1)
    await e.ev(`(() => { const q = document.querySelectorAll('.loom-ask-q')[1]; q.querySelector('[data-o="1"]').click(); q.querySelector('[data-o="2"]').click(); return true })()`)
    await e.ev(`document.querySelectorAll('.loom-ask-other')[1].focus()`)
    await e.typeText('XL')
    console.log('      shots:', await e.shot('asks-question-picked'))
    await e.enter()
    const qa = await replied(/answers/)
    const ans = answers().at(-1)?.response
    check(
      'Submit → allow with updatedInput.answers (single, multi + Other)',
      !!qa && ans?.behavior === 'allow' && ans.updatedInput?.answers?.['Which color?'] === 'Red' && ans.updatedInput?.answers?.['Which sizes?'] === 'Medium, Large, XL' && Array.isArray(ans.updatedInput?.questions),
      JSON.stringify(ans?.updatedInput?.answers)
    )

    // ---- ExitPlanMode
    await e.say('plan it')
    await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.[0] === 'plan' ? true : null), 5000)
    const planHtml = await e.ev(`document.querySelector('.loom-ask-plan')?.innerHTML ?? ''`)
    check('plan card renders the plan as markdown', /<h1|<h2|<h3/.test(planHtml) && /<strong>flag<\/strong>/.test(planHtml) && /<li>/.test(planHtml))
    console.log('      shots:', await e.shot('asks-plan'))
    await e.ev(`document.querySelector('.loom-ask-card button[data-a="edits"]').click()`)
    const approved = await replied(/plan approved/)
    const pa = answers().at(-1)?.response
    check('Approve → allow with setMode acceptEdits', !!approved && pa?.behavior === 'allow' && pa.updatedPermissions?.[0]?.mode === 'acceptEdits')
    const mode = await e.until(async () => ((await loom(e, tab))?.native?.permissionMode === 'acceptEdits' ? true : null), 3000)
    check('and the mode is switched (set_permission_mode)', !!mode && controls('set_permission_mode').some((c) => c.request.mode === 'acceptEdits'))
    const chip = await e.ev(`document.querySelector('.loom-bar-mode')?.textContent ?? ''`)
    check('the bar says accept edits', chip === 'accept edits', chip)

    await e.say('plan again')
    await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.[0] === 'plan' ? true : null), 5000)
    await wait(150)
    await e.ev(`document.querySelector('.loom-ask-card-say').focus()`)
    await e.typeText('smaller steps')
    await e.enter()
    const kept = await replied(/plan deny/)
    check('Keep planning with feedback → deny with the message', !!kept && /smaller steps/.test(answers().at(-1)?.response?.message ?? ''))

    // ---- elicitation
    await e.say('elicit one')
    await e.until(async () => ((await loom(e, tab))?.native?.askKinds?.[0] === 'elicitation' ? true : null), 5000)
    const fields = await e.ev(`document.querySelectorAll('.loom-ask-form [data-k]').length`)
    check('elicitation card: a form from requested_schema', fields === 3, String(fields))
    console.log('      shots:', await e.shot('asks-elicit'))
    await e.ev(`(() => {
      const f = (k) => document.querySelector('.loom-ask-form [data-k="' + k + '"]')
      f('project').value = 'NIMOM'; f('title').value = 'Crash on start'; f('urgent').checked = true
      document.querySelector('.loom-ask-card button[data-a="accept"]').click(); return true })()`)
    const el = await replied(/elicitation accept/)
    const ea = answers().at(-1)?.response
    check('Submit → accept with the content', !!el && ea?.action === 'accept' && ea.content?.project === 'NIMOM' && ea.content?.title === 'Crash on start' && ea.content?.urgent === true, JSON.stringify(ea))

    // ---- withdrawn
    await e.say('cancelme')
    const opened = await e.until(async () => ((await loom(e, tab))?.native?.asks === 1 ? true : null), 5000)
    const withdrawn = await replied(/cancel withdrawn/, 6000)
    check('control_cancel_request closes the card', !!opened && !!withdrawn && (await loom(e, tab))?.native?.asks === 0)
  } finally {
    e.close()
  }
}

// ---------------------------------------------------------------- 2. the real one

if (!FAKE_ONLY) {
  const folder = join(process.env.TEMP ?? '.', `ember-native-composer-real-${Date.now()}`)
  mkdirSync(folder, { recursive: true })
  const e = await ember('real', PORT + 1, { EMBER_CLAUDE_ARGS: '--model haiku' })
  try {
    const tab = await claudeTab(e, folder)
    const t0 = Date.now()
    const ready = await e.until(async () => (await loom(e, tab))?.native?.phase === 'idle', 90000)
    check('real claude comes up', !!ready, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
    const results = async () => Object.entries((await loom(e, tab))?.native?.counts ?? {}).filter(([k]) => k.startsWith('result')).reduce((n, [, v]) => n + v, 0)
    await e.say('/context')
    const ctx = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && (await results()) >= 1 ? l : null
    }, 120000)
    console.log('      canvas text:', JSON.stringify((ctx?.text ?? '').slice(0, 240)))
    check('real /context renders something', !!ctx && /context|tokens/i.test(ctx.text.replace('/context', '')))
    console.log('      shots:', await e.shot('real-context'))

    await e.ev(picture('paste', '#e01010', 64))
    await e.until(async () => ((await loom(e, tab))?.native?.attachments === 1 ? true : null), 3000)
    await e.say('What color is this square? Answer in one word.')
    const color = await e.until(async () => {
      const l = await loom(e, tab)
      return l?.native?.phase === 'idle' && (await results()) >= 2 ? l : null
    }, 120000)
    const tail = (color?.text ?? '').split('What color is this square? Answer in one word.').pop() ?? ''
    console.log('      reply:', JSON.stringify(tail.slice(0, 120)))
    check('real image paste round-trips: the reply says red', /\bred\b/i.test(tail))
    console.log('      shots:', await e.shot('real-image'))
    await e.ev(`window.__ember.newTab()`)
    await e.ev(`window.__ember.closeTab(${JSON.stringify(tab)})`)
  } finally {
    e.close()
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
