import { app, BrowserWindow, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmberConfig } from '../shared/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Ember's own windows never leave the page they were opened on.
 *
 * Left to Chromium, a file dropped anywhere the page does not handle it navigates the
 * window to file:///that-file — and the preload runs again on whatever loads, handing
 * `window.ember` (spawn, write, everything) to a document nobody vetted. The renderer
 * swallows drops itself; this is the version that holds even if it does not. Same page
 * still goes through, so a reload works, and in dev anything from the Vite server does,
 * so HMR's full reload keeps working.
 *
 * Hooked on every web contents rather than per window so any future window is covered
 * too. Panel <webview>s are left alone: browsing inside a panel is their job, and they
 * have no preload to hand over.
 */
const samePage = (a: string, b: string): boolean => {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return false
  }
}
const allowedNavigation = (wc: WebContents, url: string): boolean => {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl && !app.isPackaged) {
    try {
      if (new URL(url).origin === new URL(devUrl).origin) return true
    } catch {
      /* fall through to the same-page check */
    }
  }
  return samePage(url, wc.getURL())
}
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'window') return
  // Only the top frame is held: the page's own iframes (the bridge on 127.0.0.1) may
  // redirect inside themselves without taking the window anywhere.
  const guard = (e: Electron.Event, url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !allowedNavigation(wc, url)) e.preventDefault()
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
})

export function createWindow(config: EmberConfig): BrowserWindow {
  // EMBER_PROBE_BOUNDS=WxH gives a probe a fixed, comparable window without maximising
  // over the person's screen.
  const bounds = /^(\d+)x(\d+)$/.exec(process.env['EMBER_PROBE_BOUNDS'] ?? '')
  const win = new BrowserWindow({
    width: bounds ? Number(bounds[1]) : 1180,
    height: bounds ? Number(bounds[2]) : 720,
    minWidth: 480,
    minHeight: 280,
    show: false,
    // 'hidden' rather than frame:false — keeps Windows 11 snap layouts, rounded
    // corners and shadow, while letting us draw our own chrome.
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    // A packaged build takes its icon from the executable; a dev run would otherwise
    // show Electron's, which is not what a screenshot of the taskbar should say.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    // Opaque stone (Basalt), no system backdrop: the window is the theme's ground until
    // the page paints over it, so it never flashes white or shows the desktop.
    backgroundColor: config.theme.background,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // Not sandboxed: the preload is an ES module and reads the home directory from
      // node:os, and a sandboxed preload can have neither. contextIsolation is what keeps
      // node out of the page.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Terminal output and the animation loop must keep running when the window
      // is not focused; Chromium throttles rAF and timers to 1Hz otherwise.
      backgroundThrottling: false,
      spellcheck: false,
      // The visualisation panel. A <webview> rather than a WebContentsView because it
      // is laid out by CSS like everything else here — it clips to rounded corners,
      // fades, and slides with the panel spring. A WebContentsView is an overlay the
      // page cannot position mid-animation, which in an app made of springs shows.
      // It is also the isolation boundary: model-authored HTML runs in there, with no
      // preload and no node, and cannot see `window.ember`.
      webviewTag: true,
      // The PDF viewer: a PDF shown on the canvas opens in a webview that needs it.
      plugins: true,
    },
  })

  // Probes set EMBER_PROBE_INACTIVE so their window comes up behind whatever the person
  // is working in, rather than over it with the keyboard focus. A probe that steals focus
  // measures the person's typing instead of its own, and they lose the keystrokes.
  win.once('ready-to-show', () => {
    if (process.env['EMBER_PROBE_INACTIVE']) win.showInactive()
    else {
      // Ember opens maximized, the way an app you work in all day should; a probe keeps
      // the fixed size it asked for.
      if (!bounds) win.maximize()
      win.show()
    }
  })

  // Ctrl+Shift+I opens the developer tools, in releases too: when something goes wrong on
  // someone's machine, its console is the quickest way to see why.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && !input.alt && input.key.toLowerCase() === 'i') {
      e.preventDefault()
      win.webContents.toggleDevTools()
    }
  })

  const emitMaximized = () => win.webContents.send('ember:win:maximized', win.isMaximized())
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)

  // Links typed/clicked in the terminal open in the real browser, never in-app.
  // Only web links leave the app: handing anything else (about:blank, custom
  // schemes) to the shell makes Windows hunt the Store for a handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Belt and braces around the panel's webview. The renderer sets none of these, but
  // the guarantee that panel content cannot reach the app has to be enforced where it
  // cannot be talked out of — a compromised renderer could otherwise ask for a guest
  // with node integration and a preload of its choosing.
  win.webContents.on('will-attach-webview', (_e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    // Only the bridge and the open web. Never file:// — that is the one scheme that
    // could read the user's disk from inside a panel.
    if (!/^https?:\/\//i.test(String(params.src ?? ''))) params.src = 'about:blank'
  })

  // A link clicked inside a panel goes to the real browser, exactly as one clicked in
  // the terminal does. Nothing opens a second Electron window.
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  // Probe-only switches, passed through to the page as a query string. Kept to flags a
  // probe sets on the command line rather than config keys, so nothing here can be
  // reached by accident from the settings panel or survive a restart.
  const probe = process.argv.includes('--no-webgl') ? { search: 'noWebgl=1' } : {}

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(probe.search ? `${devUrl}?${probe.search}` : devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), probe)
  }

  return win
}
