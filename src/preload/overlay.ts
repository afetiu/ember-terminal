import { contextBridge, ipcRenderer } from 'electron'
import type { DeskOverlayState } from '../shared/types.js'

/**
 * The pointer overlay's whole API: a handful of calls. It is Ember's own page (resources/
 * desk-overlay.html), but it sits over everything the person has open, so it gets no
 * more than it needs — nothing of `window.ember`.
 */
contextBridge.exposeInMainWorld('overlay', {
  onState: (cb: (s: DeskOverlayState) => void) => {
    ipcRenderer.on('ember:desk:overlay', (_e, s: DeskOverlayState) => cb(s))
  },
  /** The mouse is over the Stop pill (true) or back on the see-through part (false). */
  interactive: (on: boolean) => ipcRenderer.send('ember:desk:overlay:interactive', on),
  /** The pill was pressed: halt, or resume when already halted. */
  stop: () => ipcRenderer.send('ember:desk:toggle'),
  /** What Ember says next to where it points; null hides it. */
  onCallout: (cb: (c: { text: string; x: number; y: number; rect?: { left: number; top: number; right: number; bottom: number }; step?: number; steps?: number } | null) => void) => {
    ipcRenderer.on('ember:desk:callout', (_e, c) => cb(c))
  },
  /** A callout's Next or Done was pressed. */
  calloutAction: (a: string) => ipcRenderer.send('ember:desk:callout:action', a),
  real: true,
})
