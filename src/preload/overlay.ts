import { contextBridge, ipcRenderer } from 'electron'
import type { DeskOverlayState } from '../shared/types.js'

/**
 * The cursor overlay's whole API: three calls. It is Ember's own page (resources/
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
})
