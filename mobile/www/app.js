/**
 * Ember on the phone.
 *
 * Not a second Ember. This is a front end onto whichever of the user's machines he picks — the
 * same orchestrator, the same conversation, the same crew of Claude sessions with all his
 * real context. Everything it appears to do, it asks that machine to do.
 *
 * The phone joins an *account*, not a laptop. It sees a live list — personal laptop, work
 * laptop, whatever is running — and connects to one. Adding a machine later is a one-time
 * step on that machine and changes nothing here.
 *
 * The exception, and the reason this app exists at all, is the call. When he is driving,
 * the microphone that matters is this one, so the phone holds its own WebRTC session
 * straight to OpenAI. Audio therefore never crosses the relay; only tool calls and their
 * results do, which are small and latency-tolerant. A weak signal degrades dispatching
 * rather than the conversation, and losing the link in a tunnel does not drop the call.
 *
 * The realtime frame is byte-identical to the desktop's, including its turn-gating — the
 * fix for the orchestrator answering the same question three times lives in there, and
 * duplicating it here would mean duplicating that bug's return.
 */
import { AccountLink, parseAccountUrl, newDeviceId } from './protocol.js'
import { BAKED } from './account.js'

const VOICE = 'cedar'
const MODEL = 'gpt-realtime-2.1'

const $ = (id) => document.getElementById(id)

const store = {
  get: (k, fallback = null) => {
    try {
      return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback
    } catch {
      return fallback
    }
  },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  clear: () => localStorage.clear(),
}

let link = null
let account = null
/** The machine we are talking to, or null while choosing. */
let target = null
let linkState = 'connecting'
let callState = 'idle'
let busy = false

/** Pending requests, by id, so a reply finds the thing that asked. */
const waiting = new Map()
let seq = 0

const targetOnline = () => !!(target && link?.isOnline(target.id))

// ---------------------------------------------------------------- screens

function show(which) {
  for (const id of ['pair', 'devices', 'talk']) $(id).classList.toggle('is-on', id === which)
}

// ---------------------------------------------------------------- the machine list

function paintDevices() {
  const list = $('devlist')
  const status = $('dstatus')
  status.textContent = linkState === 'online' ? 'connected' : 'reconnecting…'
  status.className = `status${linkState === 'online' ? '' : ' is-off'}`

  const desks = link?.desks ?? []
  list.textContent = ''

  if (!desks.length) {
    const none = document.createElement('div')
    none.className = 'devempty'
    none.textContent =
      linkState === 'online'
        ? 'None of your machines are running Ember right now.'
        : 'Looking for your machines…'
    list.appendChild(none)
    return
  }

  for (const d of desks) {
    const row = document.createElement('button')
    row.className = 'dev'
    row.addEventListener('click', () => choose(d))

    const dot = document.createElement('span')
    dot.className = 'devdot'
    const name = document.createElement('span')
    name.className = 'devname'
    name.textContent = d.name
    const state = document.createElement('span')
    state.className = 'devstate'
    state.textContent = 'online'

    row.append(dot, name, state)
    list.appendChild(row)
  }
}

function choose(device) {
  target = { id: device.id, name: device.name }
  store.set('ember.lastDevice', target)
  $('devname').textContent = device.name
  turns.length = 0
  show('talk')
  paint()
  paintStatus()
  void link.send(target.id, { t: 'hello' })
}

// ---------------------------------------------------------------- the conversation

const turns = []

function say(who, text, opts = {}) {
  const t = String(text || '').trim()
  if (!t) return
  turns.push({ who, text: t, ...opts })
  while (turns.length > 200) turns.shift()
  paint()
}

function paint() {
  const log = $('log')
  log.textContent = ''
  for (const t of turns) {
    const row = document.createElement('div')
    row.className = `turn is-${t.who}${t.spoken ? ' is-spoken' : ''}`
    if (t.did?.length) {
      const did = document.createElement('div')
      did.className = 'did'
      did.textContent = t.did.join(' · ')
      row.appendChild(did)
    }
    const body = document.createElement('div')
    body.className = 'text'
    body.textContent = t.text
    row.appendChild(body)
    log.appendChild(row)
  }
  if (busy) {
    const think = document.createElement('div')
    think.className = 'turn is-agent is-thinking'
    think.textContent = 'working…'
    log.appendChild(think)
  }
  log.scrollTop = log.scrollHeight
}

function paintStatus() {
  const el = $('status')
  const call = $('call')
  const reachable = targetOnline()
  let text
  if (linkState !== 'online') text = 'reconnecting…'
  else if (!reachable) text = 'Ember is not running on this machine'
  else if (callState === 'live') text = 'on a call'
  else if (callState === 'connecting') text = 'connecting the call…'
  else text = 'connected'
  el.textContent = text
  el.className = `status${reachable && linkState === 'online' ? '' : ' is-off'}`

  call.classList.toggle('is-live', callState === 'live' || callState === 'connecting')
  call.setAttribute('aria-label', callState === 'idle' ? 'Call Ember' : 'Hang up')
  // Typing to a machine that is not there would look like being ignored, so it is refused
  // up front. The call needs it too — the machine mints the secret before it can dial.
  $('send').disabled = busy || !reachable
  call.disabled = !reachable
}

// ---------------------------------------------------------------- the machine

/** Ask the chosen machine something and wait. Never rejects; resolves to a sentence. */
function askDesk(msg, timeoutMs = 180_000) {
  if (!link || !target) return Promise.resolve({ text: 'No machine selected.' })
  const id = `p${++seq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      // A tool call that never returns leaves the model holding the floor in silence, so
      // a timeout has to become an answer rather than nothing.
      resolve({ text: 'Your machine did not answer in time.' })
    }, timeoutMs)
    waiting.set(id, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
    void link.send(target.id, { ...msg, id })
  })
}

function fromDesk(m, from) {
  // A message from a machine that is not the one on screen. It cannot be shown without
  // making the thread a mix of two conversations, which is worse than dropping it.
  if (!target || from !== target.id) return

  const pending = m.id !== undefined ? waiting.get(m.id) : null
  if (pending) {
    waiting.delete(m.id)
    pending(m)
    return
  }

  switch (m.t) {
    case 'ready':
      // What has been said already, so a call picked up in the car does not begin from
      // nothing. It goes in as context rather than as something to read out.
      if (m.recap) rtc({ action: 'notice', text: `Context so far: ${m.recap}`, speak: false })
      break

    case 'note':
      say('system', m.text)
      if (callState === 'live') rtc({ action: 'notice', text: m.text, speak: true })
      break

    case 'panel':
      showPanel(m)
      break

    case 'panelClear':
      hidePanel()
      $('panelshow').classList.add('is-hidden')
      lastPanel = null
      break
  }
}

// ---------------------------------------------------------------- the panel

/** The last document received, so dismissing it is not the same as losing it. */
let lastPanel = null

/**
 * Show a visualisation the machine pushed.
 *
 * It opens by itself, and that is the point rather than an oversight: the panel exists
 * because the user should not have to think to go and look at it. That argument does not stop
 * applying when he is holding the phone — if anything it applies harder, because there is
 * no second screen already in view.
 *
 * The document is dropped into a frame sandboxed without `allow-same-origin`, which gives
 * it a null origin. It can run its own scripts and draw its own diagrams; it cannot read
 * this app's storage, and therefore cannot reach the account key. That is the isolation
 * the webview provides on the desk, provided differently.
 */
function showPanel(m) {
  const frame = $('panelframe')
  if (m.tooBig) {
    lastPanel = null
    $('paneltitle').textContent = m.title || 'Panel'
    frame.srcdoc = `<body style="margin:0;padding:24px;background:#14141d;color:#8f8aa3;
      font:14px/1.5 system-ui,sans-serif">That visualisation is too large to send to a
      phone (${Math.round((m.tooBig || 0) / 1024)}KB). It is on the laptop.</body>`
  } else {
    lastPanel = m
    $('paneltitle').textContent = m.title || 'Panel'
    frame.srcdoc = m.html || ''
  }
  $('panel').classList.add('is-on')
  $('panelshow').classList.remove('is-hidden')
}

function hidePanel() {
  $('panel').classList.remove('is-on')
}

// ---------------------------------------------------------------- the call

function rtc(msg) {
  $('rtc').contentWindow?.postMessage({ __ember: 'ember-realtime', ...msg }, '*')
}

window.addEventListener('message', async (e) => {
  const m = e.data

  // A button pressed inside a panel document. It arrives by postMessage because the frame
  // has no origin and nothing to POST to — see the runtime in panelDoc.ts. Forwarded to
  // the machine the panel came from, where it lands in the session it belongs to.
  if (m && m.__emberPanel === true) {
    if (target) void link?.send(target.id, { t: 'act', text: m.text, submit: m.submit !== false })
    return
  }

  if (!m || m.__emberRealtime !== true) return

  switch (m.type) {
    case 'up':
      callState = 'live'
      paintStatus()
      break

    case 'down':
      if (callState !== 'idle') {
        callState = 'idle'
        void holdScreen(false)
        paintStatus()
      }
      break

    case 'said':
      say(m.who === 'user' ? 'you' : 'agent', m.text, { spoken: true })
      // Folded into the machine's thread too, so a conversation had in the car continues
      // at the desk without re-explaining it.
      if (target) void link?.send(target.id, { t: 'line', who: m.who, text: m.text })
      break

    // Every tool the voice calls runs on the chosen machine, against real sessions.
    case 'tool': {
      const out = await askDesk({ t: 'tool', name: m.name, args: m.args })
      rtc({ action: 'answer', id: m.id, text: out.text ?? 'That did not work.' })
      break
    }

    case 'error':
      if (m.where === 'microphone' || m.where === 'connect') {
        callState = 'idle'
        void holdScreen(false)
        say('system', `The call failed: ${m.message}`)
        paintStatus()
      }
      break
  }
})

/**
 * Keep the screen awake for the length of a call.
 *
 * This is the phone-in-a-car-mount case, and it is a partial answer rather than a complete
 * one: it stops the display sleeping mid-conversation, but Android will still eventually
 * throttle a backgrounded WebView, so a call survives the screen dimming and not the app
 * being swiped away. The complete answer is a foreground service with a microphone type,
 * which is native code that cannot be verified without a device — see mobile/README.md.
 */
let wake = null

async function holdScreen(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator) wake = await navigator.wakeLock.request('screen')
    else if (!on && wake) {
      await wake.release()
      wake = null
    }
  } catch {
    // Refused or unsupported. Not worth telling him about mid-call; the call still works.
  }
}

// Android drops a wake lock whenever the page is hidden, and does not give it back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && callState !== 'idle') void holdScreen(true)
})

async function toggleCall() {
  if (callState !== 'idle') {
    rtc({ action: 'disconnect' })
    callState = 'idle'
    void holdScreen(false)
    paintStatus()
    return
  }
  if (!targetOnline()) return

  callState = 'connecting'
  paintStatus()

  // The machine mints it. The real OpenAI key never comes near a device that can be left
  // in a taxi; what arrives is good for one session and a few minutes.
  const res = await askDesk({ t: 'secret', voice: VOICE, model: MODEL }, 30_000)
  const auth = res.auth
  if (!auth?.ok) {
    callState = 'idle'
    say('system', auth?.error ? `Could not start the call: ${auth.error}` : 'Could not start the call.')
    paintStatus()
    return
  }
  void holdScreen(true)
  rtc({ action: 'connect', auth })
}

// ---------------------------------------------------------------- typing

async function send() {
  const box = $('box')
  const text = box.value.trim()
  if (!text || busy || !targetOnline()) return
  box.value = ''
  box.style.height = 'auto'
  say('you', text)

  busy = true
  paint()
  paintStatus()
  const reply = await askDesk({ t: 'say', text })
  busy = false
  say('agent', reply.text || 'No answer came back.', reply.did?.length ? { did: reply.did } : {})
  paintStatus()
}

// ---------------------------------------------------------------- joining

async function connect(acc) {
  link?.stop()
  account = acc
  link = new AccountLink({
    relay: acc.relay,
    key: acc.key,
    deviceId: acc.deviceId,
    kind: 'phone',
    name: acc.deviceName,
    onMessage: fromDesk,
    onRoster: () => {
      paintDevices()
      // The chosen machine going offline has to reach the conversation screen too, or it
      // sits there looking connected to something that closed twenty minutes ago.
      if (target) paintStatus()
    },
    onStatus: (s) => {
      linkState = s
      paintDevices()
      if (target) paintStatus()
    },
  })
  await link.start()

  // Straight back to the machine last used, if it is up. Choosing from a list every time
  // would be ceremony for the common case of one laptop.
  const last = store.get('ember.lastDevice')
  show('devices')
  paintDevices()
  if (last) {
    const seen = await new Promise((r) => {
      const started = Date.now()
      const tick = setInterval(() => {
        const found = (link.desks ?? []).find((d) => d.id === last.id)
        if (found || Date.now() - started > 6000) {
          clearInterval(tick)
          r(found ?? null)
        }
      }, 200)
    })
    if (seen) choose(seen)
  }
}

/**
 * Give an account this phone's own identity.
 *
 * The device id is made once and kept. A fresh one per launch would show up on the laptop
 * as an endless list of phones, each of them online for as long as the app happened to be
 * open — and the roster is the thing being looked at.
 */
function identity(parsed) {
  const deviceId = store.get('ember.deviceId') ?? newDeviceId()
  store.set('ember.deviceId', deviceId)
  const acc = {
    relay: parsed.relay,
    key: parsed.key,
    deviceId,
    deviceName: store.get('ember.deviceName') ?? 'Phone',
  }
  store.set('ember.account', acc)
  return acc
}

function adopt(text) {
  const parsed = parseAccountUrl(text)
  if (!parsed) {
    $('camNote').textContent = 'That is not an Ember account code.'
    return false
  }
  stopCamera()
  void connect(identity(parsed))
  return true
}

// ---- the camera ----
//
// BarcodeDetector rather than a scanning library or a native plugin: the WebView here is
// Chromium, which has had it for years, and a QR read once during setup does not justify
// shipping a decoder. Where it is missing, pasting is offered instead — that is why the
// fallback exists rather than as politeness.

let camStream = null
let camTimer = null

function stopCamera() {
  clearInterval(camTimer)
  camTimer = null
  camStream?.getTracks().forEach((t) => t.stop())
  camStream = null
  $('cam').classList.remove('is-on')
}

async function startCamera() {
  if (!('BarcodeDetector' in window)) {
    $('camNote').textContent = 'This phone cannot scan in-app — paste the code instead.'
    $('manual').open = true
    return
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  } catch (err) {
    $('camNote').textContent = `No camera: ${err.name || err}. Paste the code instead.`
    $('manual').open = true
    return
  }

  const video = $('cam')
  video.srcObject = camStream
  video.classList.add('is-on')
  await video.play().catch(() => {})

  const detector = new BarcodeDetector({ formats: ['qr_code'] })
  $('camNote').textContent = 'Looking for the code…'
  camTimer = setInterval(async () => {
    try {
      const found = await detector.detect(video)
      for (const b of found) if (adopt(b.rawValue)) return
    } catch {
      /* a frame that will not decode is the normal case, not an error */
    }
  }, 350)
}

// ---------------------------------------------------------------- wiring

$('send').addEventListener('click', () => void send())
$('call').addEventListener('click', () => void toggleCall())
$('scan').addEventListener('click', () => void startCamera())
$('usePasted').addEventListener('click', () => adopt($('pasted').value))

$('panelclose').addEventListener('click', () => hidePanel())
$('panelshow').addEventListener('click', () => {
  if ($('panel').classList.contains('is-on')) hidePanel()
  else if (lastPanel || $('panelframe').srcdoc) $('panel').classList.add('is-on')
})

$('back').addEventListener('click', () => {
  // The call belongs to the machine it was placed to, so stepping back ends it rather
  // than leaving one running against a conversation no longer on screen.
  if (callState !== 'idle') {
    rtc({ action: 'disconnect' })
    callState = 'idle'
    void holdScreen(false)
  }
  target = null
  hidePanel()
  $('panelshow').classList.add('is-hidden')
  $('panelframe').srcdoc = ''
  lastPanel = null
  show('devices')
  paintDevices()
})

$('box').addEventListener('input', (e) => {
  e.target.style.height = 'auto'
  e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`
})
$('box').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
})

$('menu').addEventListener('click', () => {
  if (!confirm('Leave this Ember account? You will need the code from one of your machines to get back in.')) return
  store.clear()
  // Remembered, or the baked account would sign him straight back in on reload and
  // "leave" would look like it did nothing.
  store.set('ember.left', true)
  link?.stop()
  link = null
  location.reload()
})

/**
 * What happens on first launch.
 *
 * Nothing, ideally. The build carries the user's account, so installing the app is the whole
 * setup — it comes up already knowing his machines. Asking him to scan a code on a laptop
 * he is not sitting at was the wrong shape of question, and having built the APK for him
 * there was never a need to ask it.
 *
 * The join screen survives for the case the baked account cannot cover: a build made on a
 * machine that has not joined yet, or a phone he has deliberately signed out of.
 */
const saved = store.get('ember.account')
if (saved?.key) void connect(saved)
else if (BAKED?.key && !store.get('ember.left')) void connect(identity(BAKED))
else show('pair')
