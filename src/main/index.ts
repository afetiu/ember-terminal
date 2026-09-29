import { app, BrowserWindow } from 'electron'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { registerIpc } from './ipc.js'
import { ConPtyHost } from './pty/ConPtyHost.js'
import { applyGlass, createWindow } from './window.js'
import { registerVoice } from './voice.js'
import { startBridge, stopBridge } from './bridge.js'
import { preferFastGpu, relaunchForGpu } from './gpu.js'

// The voice view runs Whisper in wasm, which needs SharedArrayBuffer for threads —
// 2s per utterance instead of 7s. In a browser that comes from COOP/COEP headers; a
// framed page cannot earn it that way, so Electron grants it directly.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
// Chromium keeps a spare renderer process warm for the next navigation; Ember never
// navigates, so that is ~90 MB idle for nothing (measured with scripts/probe-jank.mjs).
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess')

// Chromium throttles compositing and rAF aggressively by default. The entire point
// of this app is frame-accurate motion, so opt out of the throttling heuristics.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// Chromium's disk cache is single-writer, but a dev run and every probe script share the
// installed app's session directory. Starting one while Ember is already open floods
// stderr with "Unable to move the cache: Access is denied" and "Gpu Cache Creation
// failed". Nothing worth keeping lives there — config and scrollback are in ~/.ember — so
// an unpackaged run gets a session directory of its own, keyed by pid so concurrent
// probes don't collide with each other either.
if (!app.isPackaged) {
  const dir = join(app.getPath('temp'), `ember-dev-session-${process.pid}`)
  app.setPath('sessionData', dir)
  // Probes kill the process outright, so a will-quit hook would rarely fire. Sweep on the
  // way in instead: anything a day old belongs to a run that is long gone.
  try {
    const parent = app.getPath('temp')
    for (const name of readdirSync(parent)) {
      if (!name.startsWith('ember-dev-session-')) continue
      const stale = join(parent, name)
      if (Date.now() - statSync(stale).mtimeMs < 86_400_000) continue
      rmSync(stale, { recursive: true, force: true })
    }
  } catch {
    // Sweeping is housekeeping. A locked directory from a live run is not an error.
  }
}

const host = new ConPtyHost()

// Only the installed app claims the single-instance lock. A dev run shares the same
// userData path, so enforcing it there means `pnpm dev` silently quits whenever the
// installed Ember happens to be open — and every probe script hits the same wall.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    // Before anything is on screen: if this is the first run and the fast GPU was just
    // requested, come back as a process that actually gets it.
    if (await preferFastGpu()) {
      relaunchForGpu()
      return
    }
    const config = loadConfig()
    // Before the window: a restored tab spawns its shell almost immediately, and a
    // shell that starts before the bridge is listening never learns where its panel is.
    await startBridge()
    const win = createWindow(config)
    // The glass is half main-process: material and window alpha are properties of the
    // OS window, so a settings change has to reach here as well as the renderer.
    registerIpc(host, (next) => {
      applyGlass(win, next)
    })
    registerVoice()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(loadConfig())
    })
  })

  app.on('window-all-closed', () => {
    host.killAll()
    app.quit()
  })

  app.on('before-quit', () => {
    host.killAll()
    stopBridge()
  })
}
