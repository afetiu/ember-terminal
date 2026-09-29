import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, screen, type Display } from 'electron'
import { CONFIG_DIR } from './config.js'
import { resourcePath } from './resources.js'
import type { DeskActivity, DeskOverlayState, DeskState } from '../shared/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Computer use: Claude driving the desktop from a tab, as part of Ember.
 *
 * The work is done by a Python daemon (resources/desk/desk.py — pyautogui for input,
 * pywinauto for UI Automation, mss for the screen) that this module starts on first
 * use and kills with the app. A `desk` command in every Ember shell is the client;
 * outside Ember there is no port and no token, so there is no tool.
 *
 * Two things are Ember's alone. The cursor: the daemon reports each action here and a
 * transparent, click-through window draws Claude's own pointer where it is working,
 * so the person keeps their mouse and can watch. And the Stop switch: a halt file the
 * daemon checks before every command, a killed process, a state the sidebar shows —
 * pressed in the vitals strip, on the overlay's pill, or as `desk halt`.
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
  if (!port) {
    // A synchronous pick would be nicer; net has no such thing, so the listen-and-close
    // dance runs at startup and the shells that follow inherit its answer.
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close()
    })
  }
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

function pipInstall(py: string[], pkgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(py[0] as string, [...py.slice(1), '-m', 'pip', 'install', '--user', '--quiet', ...pkgs], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    p.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    p.on('exit', (code) => {
      if (code !== 0) log(`pip install failed (${code}): ${err.slice(-400)}`)
      resolve(code === 0)
    })
    p.on('error', () => resolve(false))
  })
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
  // Straight to --serve: it checks its own imports and says NEED_DEPS if one is missing,
  // which is the one case worth a second, slower round through pip.
  const outcome = await serve(py)
  if (outcome.startsWith('NEED_DEPS')) {
    const missing = outcome.slice('NEED_DEPS'.length).trim().split(/\s+/).filter(Boolean)
    setReady('installing', `installing ${missing.join(', ')}`)
    const ok = await pipInstall(py, missing)
    if (!ok) {
      setReady('no-deps', `run: python -m pip install ${missing.join(' ')}`)
      return
    }
    setReady('starting')
    const again = await serve(py)
    if (again !== 'READY') setReady(again.startsWith('NEED_DEPS') ? 'no-deps' : 'failed', again.startsWith('NEED_DEPS') ? `run: python -m pip install ${missing.join(' ')}` : again)
  } else if (outcome !== 'READY') {
    setReady('failed', outcome)
  }
}

/** Spawn the daemon; resolve with 'READY', 'NEED_DEPS …', or the reason it did not come up. */
function serve(py: string[]): Promise<string> {
  const child = spawn(py[0] as string, [...py.slice(1), resourcePath('desk', 'desk.py'), '--serve'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
      const need = /NEED_DEPS[^\n]*/.exec(out)?.[0]
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
  stopped = true
  killDaemon()
  state.ready = 'off'
  emit()
  visible = false
  pushOverlay({ visible: false, halted: true, showStop: true })
  // The Resume pill stays for a while, then the overlay gets out of the way.
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => hideOverlay(), HIDE_MS)
  return snapshot()
}

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
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    visible = false
    pushOverlay({ visible: false, halted: state.halted, showStop: false })
    setTimeout(() => {
      if (!visible) hideOverlay()
    }, 400)
  }, HIDE_MS)
}

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
    title: 'Claude',
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
