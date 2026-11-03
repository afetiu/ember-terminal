import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen, type Display } from 'electron'
import { CONFIG_DIR, loadConfig } from './config.js'
import { resourcePath } from './resources.js'
import type { DeskActivity, DeskCard, DeskOverlayState, DeskState } from '../shared/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Computer use: Claude driving the desktop from a tab, as part of Ember.
 *
 * The work is done by a Python daemon (resources/desk/desk.py — pyautogui for input,
 * pywinauto for UI Automation, mss for the screen) that this module starts on first
 * use and kills with the app. A `desk` command in every Ember shell is the client;
 * outside Ember there is no port and no token, so there is no tool.
 *
 * Two things are Ember's alone. The pointer: the daemon reports each action here and a
 * transparent, click-through window draws Ember's own pointer where it is working,
 * so the person keeps their mouse and can watch. And the Stop switch: a killed process, a
 * state the sidebar shows, a daemon that refuses — pressed in the vitals strip, on the
 * overlay's pill, or as `desk halt`. Lifted only from Ember's own UI.
 *
 * What the daemon may do is decided here, not in the shell. The Hands setting and the Stop
 * switch are held in this process and handed to the daemon under a control token that only
 * this process and the daemon know (it goes in over stdin, not the environment a shell
 * inherits). A shell's `desk`, fast path included, talks to the daemon directly; the daemon
 * refuses what the setting does not allow, and no shell can change the setting.
 */

const HALT_FILE = join(CONFIG_DIR, 'desk.halt')
const LOG_FILE = join(CONFIG_DIR, 'desk.log')
/** How long after the last action the strip keeps saying "busy". */
const IDLE_MS = 2500
/** How long the cursor stays on screen after the last action. */
const HIDE_MS = 45_000
const READY_MS = 20_000

let proc: ChildProcess | null = null
let port = 0
let token = ''
/** Ember's own key to the daemon's settings. Never in a shell's environment. */
const control = randomBytes(24).toString('hex')
/** The Hands setting the daemon was last told. */
let toldMode: Hands | null = null
let bridgeUrl = ''
let bridgeToken = ''
let overlay: BrowserWindow | null = null
let overlayDisplay: Display | null = null
let visible = false
let idleTimer: NodeJS.Timeout | null = null
let hideTimer: NodeJS.Timeout | null = null
let starting: Promise<DeskState> | null = null
let stopped = false

const state: DeskState = {
  running: false,
  busy: false,
  // The file only carries Stop across a restart. While Ember runs this flag is the
  // authority: deleting the file lifts nothing.
  halted: existsSync(HALT_FILE),
  ready: 'off',
  message: '',
  last: null,
}

const listeners = new Set<(s: DeskState) => void>()

function snapshot(): DeskState {
  return { ...state, last: state.last ? { ...state.last } : null }
}

function emit(): void {
  const s = snapshot()
  for (const cb of listeners) cb(s)
}

export function onDeskState(cb: (s: DeskState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function deskState(): DeskState {
  return snapshot()
}

function log(line: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* a log that cannot be written is not worth failing over */
  }
}

/**
 * Called once the bridge is listening. Picks the port and token now, before any shell
 * spawns, because a shell learns them only by inheritance — the daemon itself comes up
 * lazily, on the first `desk` command.
 */
export function setDeskBridge(url: string, bridgeTok: string): void {
  bridgeUrl = url
  bridgeToken = bridgeTok
  if (!token) token = randomBytes(16).toString('hex')
  // A synchronous pick would be nicer; net has no such thing, so the listen-and-close
  // dance runs at startup and the shells that follow inherit its answer. Something else
  // can take the port in between; the daemon binds it exclusively and says so if it was,
  // and launch() moves to another.
  if (!port) void freePort().then((p) => (port ||= p))
  // A changed setting reaches a running daemon within a second. Checked rather than
  // watched: the config is cached in memory, and Settings and the file watcher both
  // update that cache, so this is a comparison, not a read.
  setInterval(() => {
    if (state.running && hands() !== toldMode) tellDaemon()
  }, 1000).unref()
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(0))
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(p))
    })
  })
}

// ---------- Ember Hands: what the session may do ----------

export type Hands = 'off' | 'show' | 'act'

/** The setting, as the user left it. 'show' when unset: point and look, never press. */
export function hands(): Hands {
  const h = loadConfig().hands
  return h === 'off' || h === 'act' ? h : 'show'
}

export const HANDS_OFF = 'Computer use is off in Ember (Ctrl+K → Computer use).'
export const HANDS_SHOW = 'Computer use is set to Show in Ember: pointing and looking only. Clicking and typing need it set to Act (Ctrl+K → Computer use).'

/** What the daemon may do right now, in the shape it reads (see desk.py's header). */
function controlLine(): string {
  toldMode = hands()
  return `${JSON.stringify({ control, mode: toldMode, halted: state.halted })}\n`
}

/** Hand the daemon the current setting and switch. Fire and forget; it is re-sent on change. */
function tellDaemon(): void {
  if (!state.running || !port) return
  const sock = connect({ host: '127.0.0.1', port })
  sock.setTimeout(5000, () => sock.destroy())
  sock.on('error', () => {
    /* the daemon is gone; it will be told again when it comes back */
  })
  sock.on('connect', () => sock.end(controlLine()))
}

/** What every Ember shell carries so `desk` can find the daemon. */
export function deskEnv(): Record<string, string> {
  if (!port || !token) return {}
  return { EMBER_DESK_PORT: String(port), EMBER_DESK_TOKEN: token }
}

// ---------- the daemon ----------

function setReady(ready: DeskState['ready'], message = ''): void {
  state.ready = ready
  state.message = message
  emit()
}

function findPython(): string[] | null {
  for (const cand of [['py', '-3'], ['python'], ['python3']]) {
    try {
      const r = spawnSync(cand[0] as string, [...cand.slice(1), '-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      })
      if (r.status === 0 && r.stdout.trim() === '3') return cand
    } catch {
      /* not this one */
    }
  }
  return null
}

async function launch(): Promise<void> {
  if (state.halted) return
  const py = findPython()
  if (!py) {
    setReady('no-python', 'Python 3 is not installed — get it from python.org, then try again')
    return
  }
  if (!port) {
    setReady('failed', 'no port yet — try again in a moment')
    return
  }
  setReady('starting')
  // Straight to --serve: it checks its own imports and says NEED_DEPS if one is missing.
  let outcome = await serve(py)
  if (outcome.startsWith('PORT_IN_USE')) {
    // Something took the port between the pick and the daemon's bind. Move rather than
    // share it; shells spawned from now on get the new port.
    log(`desk port ${port} was taken by another process; moving`)
    const next = await freePort()
    if (next) {
      port = next
      outcome = await serve(py)
    }
  }
  if (outcome.startsWith('NEED_DEPS')) {
    // Installing packages is the user's call, not something a `desk` command gets to set
    // off by itself: say exactly what to run, and run nothing.
    const missing = outcome.slice('NEED_DEPS'.length).trim().split(/\s+/).filter(Boolean)
    setReady('no-deps', `missing Python packages — run: ${py.join(' ')} -m pip install --user ${missing.join(' ')}`)
  } else if (outcome !== 'READY') {
    setReady('failed', outcome)
  }
}

/** Spawn the daemon; resolve with 'READY', 'NEED_DEPS …', or the reason it did not come up. */
function serve(py: string[]): Promise<string> {
  const child = spawn(py[0] as string, [...py.slice(1), resourcePath('desk', 'desk.py'), '--serve'], {
    windowsHide: true,
    // stdin carries the control line: the one channel to the daemon a shell never shares.
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      EMBER_DESK_PORT: String(port),
      EMBER_DESK_TOKEN: token,
      EMBER_BRIDGE_URL: bridgeUrl,
      EMBER_BRIDGE_TOKEN: bridgeToken,
      EMBER_HOME: CONFIG_DIR,
      // The daemon waits on this handle and exits when Ember does, however Ember went.
      EMBER_PID: String(process.pid),
      PYTHONIOENCODING: 'utf-8',
    },
  })
  proc = child
  child.stdin?.on('error', () => {
    /* it exited before reading (NEED_DEPS); the exit handler reports why */
  })
  child.stdin?.end(controlLine())
  let err = ''
  let out = ''
  child.stderr?.on('data', (d: Buffer) => {
    err = (err + d.toString()).slice(-2000)
  })
  const lastErr = () => err.trim().split('\n').pop()?.slice(0, 160) ?? ''
  return new Promise<string>((resolve) => {
    let settled = false
    const done = (r: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      if (proc === child) {
        child.kill()
        proc = null
      }
      done(lastErr() || 'the daemon did not come up in time')
    }, READY_MS)
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('READY')) {
        state.running = true
        setReady('ok')
        done('READY')
      }
    })
    child.on('exit', (code) => {
      if (proc === child) proc = null
      const wasRunning = state.running
      state.running = false
      state.busy = false
      const need = /NEED_DEPS[^\n]*/.exec(out)?.[0] ?? /PORT_IN_USE[^\n]*/.exec(out)?.[0]
      if (!settled) {
        done(need ?? (lastErr() || `daemon exited (${code})`))
        return
      }
      // Died later, on its own: say so, unless we killed it (stop/halt) or it is Ember quitting.
      if (wasRunning && !stopped && !state.halted) {
        log(`daemon exited (${code}): ${err.trim().split('\n').slice(-3).join(' | ')}`)
        setReady('failed', lastErr() || `daemon exited (${code})`)
      } else {
        emit()
      }
    })
    child.on('error', (e) => {
      log(`daemon spawn error: ${e.message}`)
      done(e.message)
    })
  })
}

/** Bring the daemon up if it is not, and report the state either way. */
export function startDesk(): Promise<DeskState> {
  if (state.running) return Promise.resolve(snapshot())
  // Off means not even a daemon: nothing loaded, nothing listening.
  if (hands() === 'off') return Promise.resolve({ ...snapshot(), message: HANDS_OFF })
  if (starting) return starting
  stopped = false
  starting = (async () => {
    try {
      await launch()
    } finally {
      starting = null
    }
    return snapshot()
  })()
  return starting
}

function killDaemon(): void {
  const p = proc
  proc = null
  if (p && !p.killed) {
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
  state.running = false
  state.busy = false
}

export function stopDesk(): DeskState {
  stopped = true
  killDaemon()
  if (state.ready === 'ok' || state.ready === 'starting') state.ready = 'off'
  emit()
  hideOverlay()
  return snapshot()
}

// ---------- the switch ----------

export function haltDesk(): DeskState {
  try {
    writeFileSync(HALT_FILE, new Date().toISOString(), 'utf8')
  } catch (err) {
    log(`could not write the halt file: ${(err as Error).message}`)
  }
  state.halted = true
  // Told before it is killed, so a daemon that somehow survives the kill still refuses.
  tellDaemon()
  stopped = true
  killDaemon()
  state.ready = 'off'
  emit()
  visible = false
  comeBack()
  pushOverlay({ visible: false, halted: true, showStop: true })
  // The Resume pill stays for a while, then the overlay gets out of the way.
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => hideOverlay(), HIDE_MS)
  return snapshot()
}

/**
 * Lift Stop. Reached only from Ember's own UI over IPC (the strip, the overlay's pill) —
 * never from the bridge or `desk`, which belong to the session Stop is there to stop.
 */
export function resumeDesk(): DeskState {
  try {
    rmSync(HALT_FILE, { force: true })
  } catch {
    /* nothing to remove */
  }
  state.halted = false
  emit()
  pushOverlay({ visible: false, halted: false, showStop: false })
  hideOverlay()
  return snapshot()
}

export function toggleDesk(): DeskState {
  return state.halted ? resumeDesk() : haltDesk()
}

// ---------- activity → strip + cursor ----------

export function onActivity(a: DeskActivity): void {
  lastActAt = Date.now()
  // A long wait in a plan says it is still going; nothing to draw.
  if (a.action === 'tick') return
  state.last = a
  state.busy = true
  emit()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    state.busy = false
    emit()
  }, IDLE_MS)

  if (state.halted) return
  visible = true
  if (aside || shouldStepAside(a)) noteStep(a)
  const st: DeskOverlayState = { label: a.label, action: a.action, visible: true, halted: false, showStop: true }
  if (typeof a.x === 'number' && typeof a.y === 'number') {
    // The daemon speaks physical pixels (it is DPI-aware); windows are laid out in DIPs.
    const dip = screen.screenToDipPoint({ x: a.x, y: a.y })
    const display = screen.getDisplayNearestPoint(dip)
    const win = ensureOverlay(display)
    const b = win.getBounds()
    st.point = { x: dip.x - b.x, y: dip.y - b.y }
  } else if (overlay) {
    ensureOverlay(overlayDisplay ?? screen.getPrimaryDisplay())
  } else {
    ensureOverlay(screen.getPrimaryDisplay())
  }
  pushOverlay(st)
  if (a.action === 'point' && st.point && a.label) pushCallout({ text: a.label, x: st.point.x, y: st.point.y })
  else if (a.action !== 'point') pushCallout(null)
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    visible = false
    pushOverlay({ visible: false, halted: state.halted, showStop: false })
    setTimeout(() => {
      if (!visible && !aside) hideOverlay()
    }, 400)
  }, HIDE_MS)
}

// ---------- stepping aside ----------
//
// When an agent starts working in another app, Ember gets out of the way: its window
// minimises and a small card at the bottom-right of the screen says what is happening,
// with STOP. The card is drawn by the overlay page (one see-through, never-focused
// window), so it takes no focus from the app being driven, and the daemon leaves the
// overlay out of every window list it reads. When the work ends (no action for a few
// seconds and no agent turn in flight) or STOP is pressed, Ember comes back where it was.

/** Quiet this long, with no agent turn in flight, and Ember comes back. */
const ASIDE_IDLE_MS = 4000
/** Back regardless after this long without an action: a turn that never seems to end. */
const ASIDE_MAX_IDLE_MS = 120_000
/** Actions that put something into another app (not looks, not pointing). */
const STEP_ASIDE_ON = new Set(['move', 'click', 'drag', 'type', 'focus', 'scroll'])

interface Aside {
  win: BrowserWindow | null
  /** Ember was the window in front (or just had been) when it stepped aside: focus goes back to it. */
  hadFocus: boolean
  wasMaximized: boolean
  timer: NodeJS.Timeout
}
let aside: Aside | null = null
let lastActAt = 0
let agentsWorking = false
let actsInFlight = 0
let emberBlurAt = 0
let card: DeskCard | null = null

/** From the renderer: is an agent's turn in flight in any tab. */
export function setAgentsWorking(on: boolean): void {
  agentsWorking = on
}

function stepAsideEnabled(): boolean {
  return loadConfig().deskStepAside !== false
}

function shouldStepAside(a: DeskActivity): boolean {
  return stepAsideEnabled() && !state.halted && STEP_ASIDE_ON.has(a.action) && a.own === false && !!(a.app || a.win)
}

/** Ember's own window: the visible one that is not the overlay. */
function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== overlay && w.isVisible() && !w.isMinimized()) ?? null
}

function noteStep(a: DeskActivity): void {
  const text = (a.label || a.action).replace(/\s+/g, ' ').trim().slice(0, 90)
  const app = a.own === false ? a.app || a.win || '' : ''
  if (!aside) stepAside()
  const prev = card
  const trail = prev ? (prev.now && prev.now !== text ? [prev.now, ...prev.trail] : prev.trail) : []
  card = { now: text, trail: trail.slice(0, 3), app: app || prev?.app || '', inset: cardInset() }
}

function cardInset(): { right: number; bottom: number } {
  const d = overlayDisplay ?? screen.getPrimaryDisplay()
  const b = d.bounds
  const w = d.workArea
  return { right: Math.max(0, b.x + b.width - (w.x + w.width)), bottom: Math.max(0, b.y + b.height - (w.y + w.height)) }
}

function stepAside(): void {
  const win = mainWindow()
  const hadFocus = !!win && (win.isFocused() || Date.now() - emberBlurAt < 4000)
  const wasMaximized = !!win && win.isMaximized()
  if (win) win.minimize()
  aside = { win, hadFocus, wasMaximized, timer: setInterval(checkAside, 400) }
  log(`stepped aside (${win ? (wasMaximized ? 'maximised' : 'normal') : 'no window'})`)
}

function checkAside(): void {
  if (!aside) return
  const idle = Date.now() - lastActAt
  if (actsInFlight > 0 || idle < ASIDE_IDLE_MS) return
  if (agentsWorking && idle < ASIDE_MAX_IDLE_MS) return
  comeBack()
}

/** End stepping aside: the card goes, Ember's window comes back as it was. */
function comeBack(): void {
  const a = aside
  if (!a) return
  aside = null
  clearInterval(a.timer)
  card = null
  pushOverlay({ ...(lastOverlay ?? { visible: false, halted: state.halted }), card: null })
  const win = a.win
  if (win && !win.isDestroyed() && win.isMinimized()) {
    if (a.hadFocus) win.restore()
    else {
      // Back without taking the keyboard from whatever the person is in now.
      win.showInactive()
      if (a.wasMaximized && !win.isMaximized()) win.maximize()
    }
  }
  log('came back')
}

/** For probes and the bridge's status: stepping aside, as main sees it. */
export function asideState(): { aside: boolean; card: DeskCard | null; agentsWorking: boolean; minimized: boolean; maximized: boolean } {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== overlay && (w.isVisible() || w.isMinimized()))
  return { aside: !!aside, card, agentsWorking, minimized: !!win?.isMinimized(), maximized: !!win?.isMaximized() }
}

// Ember's window lost focus: remembered so stepping aside knows whether Ember had it.
app.on('browser-window-blur', (_e, w) => {
  if (w !== overlay) emberBlurAt = Date.now()
})

function ensureOverlay(display: Display): BrowserWindow {
  const b = display.bounds
  if (overlay && !overlay.isDestroyed()) {
    if (overlayDisplay?.id !== display.id) {
      overlay.setBounds(b)
      overlayDisplay = display
    }
    if (!overlay.isVisible()) overlay.showInactive()
    return overlay
  }
  overlayDisplay = display
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    show: false,
    title: 'Ember',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  overlay = win
  // Above everything, including other always-on-top windows; the mouse goes through
  // it except where the page asks otherwise (the Stop pill).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setMenuBarVisibility(false)
  win.webContents.on('did-finish-load', () => pushOverlay({ visible, halted: state.halted, showStop: visible || state.halted }))
  win.once('ready-to-show', () => {
    if (overlay === win) win.showInactive()
  })
  win.on('closed', () => {
    if (overlay === win) overlay = null
  })
  void win.loadFile(resourcePath('desk-overlay.html'))
  return win
}

let lastOverlay: DeskOverlayState | null = null
function pushOverlay(st: DeskOverlayState): void {
  // The card rides along with every state, so one sent for the pointer never drops it.
  st = { ...st, card: st.card !== undefined ? st.card : card }
  if (st.card) ensureOverlay(overlayDisplay ?? screen.getPrimaryDisplay())
  lastOverlay = st
  if (!overlay || overlay.isDestroyed()) return
  overlay.webContents.send('ember:desk:overlay', st)
}

function hideOverlay(): void {
  if (!overlay || overlay.isDestroyed()) return
  overlay.hide()
  setOverlayInteractive(false)
}

export function setOverlayInteractive(on: boolean): void {
  if (!overlay || overlay.isDestroyed()) return
  if (on) overlay.setIgnoreMouseEvents(false)
  else overlay.setIgnoreMouseEvents(true, { forward: true })
}

/** The overlay page re-asks on load; nothing else needs it. */
export function overlayState(): DeskOverlayState {
  return lastOverlay ?? { visible: false, halted: state.halted, showStop: state.halted }
}

/** Windows that are Ember's chrome — everything but the overlay. */
export function isOverlayWindow(win: BrowserWindow): boolean {
  return win === overlay
}

// ---------- Ember Hands: pointing and acting, for the session's tools ----------

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}
type Callout = { text: string; x: number; y: number; rect?: Rect; step?: number; steps?: number }

function pushCallout(c: Callout | null): void {
  if (!overlay || overlay.isDestroyed()) return
  overlay.webContents.send('ember:desk:callout', c)
}

/** Hide what Ember is saying next to the pointer. */
export function deskHideCallout(): void {
  pushCallout(null)
  setOverlayInteractive(false)
}

/** The callout's Next / Done: the bubble closes; whoever is waiting hears which. */
const calloutWaiters = new Set<(a: string) => void>()
ipcMain.on('ember:desk:callout:action', (_e, a: string) => {
  setOverlayInteractive(false)
  for (const w of calloutWaiters) w(String(a))
  calloutWaiters.clear()
})

/** One request to the daemon over its socket, from inside Ember (the shell's `desk` does the same). */
function callDaemon(argv: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string; ms?: number }> {
  return new Promise((resolve, reject) => {
    if (!port || !token) return reject(new Error('computer use is not set up yet'))
    const sock = connect({ host: '127.0.0.1', port })
    let data = ''
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('desk: timed out'))
    }, timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ argv, token, tab: '' })}\n`))
    sock.on('data', (chunk: string) => {
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

async function ensureRunning(): Promise<string | null> {
  if (state.halted) return 'HALTED: Stop was pressed. Only the person at the machine can lift it, with Resume in Ember.'
  if (hands() === 'off') return HANDS_OFF
  if (!state.running) await startDesk()
  if (!state.running) return `computer use is unavailable (${state.ready}${state.message ? `: ${state.message}` : ''})`
  return null
}

/**
 * The screen as text, for the session to find what to point at: the open windows, or one
 * window's controls (names, types, positions). Read-only and fast — no screenshot.
 */
export async function deskLook(window?: string, depth = 4): Promise<{ ok: boolean; out: string; ms?: number; error?: string }> {
  const err = await ensureRunning()
  if (err) return { ok: false, out: '', error: err }
  const argv = window ? ['tree', window, '--depth', String(Math.max(1, Math.min(8, depth)))] : ['windows']
  try {
    const r = await callDaemon(argv, 20_000)
    return { ok: r.ok, out: String(r.out ?? '').slice(0, 14_000), ms: r.ms }
  } catch (e) {
    return { ok: false, out: '', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Physical screen pixels (what the daemon speaks) to this overlay window's CSS pixels. */
function toOverlay(x: number, y: number): { x: number; y: number } {
  const dip = screen.screenToDipPoint({ x, y })
  const win = ensureOverlay(screen.getDisplayNearestPoint(dip))
  const b = win.getBounds()
  return { x: dip.x - b.x, y: dip.y - b.y }
}

/**
 * Show where something is: Ember's pointer glides to it and the callout says what it is,
 * beside it. A control is found by window title and name (UI Automation); otherwise x,y in
 * screen pixels. Never clicks, never types.
 */
export async function deskPoint(opts: {
  window?: string
  name?: string
  ctype?: string
  x?: number
  y?: number
  say?: string
  step?: number
  steps?: number
}): Promise<{ ok: boolean; x?: number; y?: number; found?: string; error?: string; ms?: number }> {
  const t0 = Date.now()
  if (state.halted) return { ok: false, error: 'HALTED: Stop was pressed.' }
  if (hands() === 'off') return { ok: false, error: HANDS_OFF }
  let x = opts.x
  let y = opts.y
  let rect: Rect | undefined
  let found = ''
  const byNumber = !!opts.name && /^#\d+$/.test(opts.name.trim())
  if (opts.name && (opts.window || byNumber)) {
    const why = await ensureRunning()
    if (why) return { ok: false, error: why }
    try {
      const argv = byNumber ? ['find', opts.name.trim()] : ['find', opts.window!, opts.name, ...(opts.ctype ? ['--type', opts.ctype] : [])]
      const r = await callDaemon(argv, 20_000)
      if (!r.ok) return { ok: false, error: r.out.trim() || 'not found', ms: Date.now() - t0 }
      const j = JSON.parse(r.out) as { name: string; center: [number, number]; rect: [number, number, number, number] }
      ;[x, y] = j.center
      found = j.name
      const a = toOverlay(j.rect[0], j.rect[1])
      const b = toOverlay(j.rect[2], j.rect[3])
      rect = { left: a.x, top: a.y, right: b.x, bottom: b.y }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 }
    }
  }
  if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, error: 'point: give a number (name #N), window + name, or x + y' }
  const at = toOverlay(x, y)
  const label = (opts.say ?? found ?? '').slice(0, 120)
  state.last = { action: 'point', x, y, label, tab: '', at: Date.now() }
  emit()
  visible = true
  pushOverlay({ visible: true, halted: false, showStop: true, point: at, action: 'point', label: found || '' })
  if (opts.say) pushCallout({ text: opts.say, x: at.x, y: at.y, ...(rect ? { rect } : {}), ...(opts.steps ? { step: opts.step ?? 1, steps: opts.steps } : {}) })
  else pushCallout(null)
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    visible = false
    pushOverlay({ visible: false, halted: state.halted, showStop: false })
    setTimeout(() => {
      if (!visible) hideOverlay()
    }, 400)
  }, HIDE_MS)
  return { ok: true, x, y, found, ms: Date.now() - t0 }
}

/**
 * Do something on the desktop: a desk batch script ("focus Notepad; press Notepad ^File$;
 * type hello"). The pointer glides to each target and the real action lands on arrival.
 * Honours Stop.
 */
export async function deskAct(script: string, save?: string[]): Promise<{ ok: boolean; output: string; error?: string; ms: number }> {
  const t0 = Date.now()
  if (hands() !== 'act') return { ok: false, output: '', error: hands() === 'off' ? HANDS_OFF : HANDS_SHOW, ms: 0 }
  const why = await ensureRunning()
  if (why) return { ok: false, output: '', error: why, ms: Date.now() - t0 }
  pushCallout(null)
  actsInFlight++
  try {
    const r = await callDaemon(['do', script], 10 * 60_000)
    let out = r.out.trim()
    if (r.ok && save?.length) {
      const s = await callDaemon(['recipe', 'save', ...save], 20_000)
      out += `\n${s.out.trim()}`
    }
    // A failed plan's whole report is the error: which step, why, and the screen now.
    return { ok: r.ok, output: out, ...(r.ok ? {} : { error: out || 'failed' }), ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, output: '', error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 }
  } finally {
    actsInFlight--
    lastActAt = Date.now()
  }
}

/** Recipes: plans that worked, kept by name. list and show only read; run acts. */
export async function deskRecipe(op: string, name = '', args: string[] = []): Promise<{ ok: boolean; output: string; error?: string; ms: number }> {
  const t0 = Date.now()
  if (op === 'run' && hands() !== 'act') return { ok: false, output: '', error: hands() === 'off' ? HANDS_OFF : HANDS_SHOW, ms: 0 }
  const why = await ensureRunning()
  if (why) return { ok: false, output: '', error: why, ms: Date.now() - t0 }
  if (op === 'run') actsInFlight++
  try {
    const r = await callDaemon(['recipe', op, ...(name ? [name] : []), ...args], 10 * 60_000)
    const out = r.out.trim()
    return { ok: r.ok, output: out, ...(r.ok ? {} : { error: out || 'failed' }), ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, output: '', error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 }
  } finally {
    if (op === 'run') {
      actsInFlight--
      lastActAt = Date.now()
    }
  }
}

/** Wait for the person to press Next or Done on a stepped callout (or for the timeout). */
export function deskAwaitCallout(timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      calloutWaiters.delete(done)
      resolve('timeout')
    }, timeoutMs)
    const done = (a: string) => {
      clearTimeout(t)
      resolve(a)
    }
    calloutWaiters.add(done)
  })
}
