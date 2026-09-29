import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmberConfig } from '../shared/types.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const fades = new WeakMap<BrowserWindow, NodeJS.Timeout>()
const configs = new WeakMap<BrowserWindow, EmberConfig>()

/**
 * Ease the window's own alpha, in main, over ~200ms.
 *
 * This is the one animation the renderer cannot own: `setOpacity` is a property of
 * the OS window, not of anything on the page. Stepped on a timer rather than a
 * spring because it runs while Ember is losing focus, when nothing on screen is
 * being looked at closely — it only has to not be a jump cut.
 */
function fadeTo(win: BrowserWindow, target: number): void {
  const running = fades.get(win)
  if (running) clearTimeout(running)
  const step = () => {
    if (win.isDestroyed()) return
    const from = win.getOpacity()
    const delta = target - from
    if (Math.abs(delta) < 0.005) {
      win.setOpacity(target)
      fades.delete(win)
      return
    }
    win.setOpacity(from + delta * 0.28)
    fades.set(win, setTimeout(step, 16))
  }
  step()
}

/**
 * Keep the window see-through while it is not the active one.
 *
 * Windows only draws a mica/acrylic system backdrop for the *active* window: the
 * moment Ember loses focus DWM swaps the material for a flat grey fill and the
 * terminal turns into a slab, which is exactly when you are most likely to be
 * looking through it at whatever you switched to. That is DWM
 * policy and the app cannot re-apply its way out of it — re-setting the material on
 * blur, hammering it on a timer and the legacy `SetWindowCompositionAttribute`
 * blur-behind were all measured, and on Windows 11 the accent API does not even blur
 * any more: it paints the region black. `scripts/probe-glass.mjs` has the receipts.
 *
 * What does still work is the window's own alpha. So the blur stays, and the whole
 * window fades to `window.inactiveOpacity` when it deactivates: frosted while you
 * are in it, plain glass while you are not, never a slab.
 */
export function applyGlass(win: BrowserWindow, config: EmberConfig): void {
  if (win.isDestroyed()) return
  const previous = configs.get(win)
  configs.set(win, config)
  const { material, inactiveOpacity } = config.window
  // Material can be re-set live between the backdrop modes. Switching to or from
  // 'none' cannot: per-pixel transparency is fixed when the window is created, so
  // that one still needs a relaunch.
  if (previous && previous.window.material !== material && material !== 'none' && previous.window.material !== 'none') {
    win.setBackgroundMaterial(material)
  }
  // A hand-edited config can carry anything; a bad number here would set the window's
  // alpha to NaN and make it vanish.
  const inactive = Number.isFinite(inactiveOpacity) ? Math.min(1, Math.max(0.2, inactiveOpacity / 100)) : 1
  // 'none' is already transparent per-pixel, focused or not; fading it as well would
  // dim the text for no gain.
  const wanted = material === 'none' || win.isFocused() ? 1 : inactive
  fadeTo(win, wanted)
}

export function createWindow(config: EmberConfig): BrowserWindow {
  // See applyGlass: a backdrop window is a real window with alpha, a 'none' window is
  // a transparent one. Only the second can carry per-pixel transparency, and only the
  // first can carry blur — Chromium cannot blur pixels it does not own.
  const systemBackdrop = config.window.material !== 'none'

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
    // corners, shadow and the system backdrop, while letting us draw our own chrome.
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    // A packaged build takes its icon from the executable; a dev run would otherwise
    // show Electron's, which is not what a screenshot of the taskbar should say.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    // Either way the window itself must be fully transparent, with the content layer
    // applying its own tint on top.
    backgroundColor: '#00000000',
    ...(systemBackdrop ? { backgroundMaterial: config.window.material } : { transparent: true }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
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
    },
  })

  // Probes set EMBER_PROBE_INACTIVE so their window comes up behind whatever the person
  // is working in, rather than over it with the keyboard focus. A probe that steals focus
  // measures the person's typing instead of its own, and they lose the keystrokes.
  win.once('ready-to-show', () => {
    if (process.env['EMBER_PROBE_INACTIVE']) win.showInactive()
    else win.show()
  })

  applyGlass(win, config)
  win.on('focus', () => applyGlass(win, configs.get(win) ?? config))
  win.on('blur', () => applyGlass(win, configs.get(win) ?? config))

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
