import { session } from 'electron'
import { bridgeOrigin } from './bridge.js'

/**
 * Who is allowed to use the microphone.
 *
 * One page: the realtime call, served by Ember from its own bridge. Every terminal pane
 * and every panel is denied, which is most of the reason speech runs on a separate origin at all —
 * a panel is model-authored content, and it should not be able to ask for the microphone
 * however it is written.
 *
 * **This list is load-bearing and it is a path allowlist, not an origin one.** The call
 * page shipped with only `/speech` here and every call died on `NotAllowedError` — the
 * feature was complete, correct, and mute. Nothing upstream catches it: the page is
 * served, the session mints, the data channel opens, and `getUserMedia` is the last
 * thing to run. Adding a page that needs the microphone means adding it here.
 *
 * It used to also cover `/speech`, the Azure narration-and-dictation frame. That whole
 * subsystem is gone: the orchestrator supersedes it, and one-way speech in a terminal
 * that can now hold a conversation was surface nobody was going to reach for again.
 */
const MIC_PAGES = ['/realtime']

export function registerVoice(): void {
  const allowed = (url: string): boolean => {
    const bridge = bridgeOrigin()
    return !!bridge && MIC_PAGES.some((page) => url.startsWith(`${bridge}${page}`))
  }

  // The app's own page (file://) reads the clipboard for Ctrl+V; nothing loaded from the
  // bridge (panel documents carry model-authored markup) may.
  const ownPage = (url: string) => url.startsWith('file://')
  const clipboard = (permission: string) => permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const url = details?.requestingUrl ?? ''
    callback((permission === 'media' && allowed(url)) || (clipboard(permission) && ownPage(url)))
  })

  // getUserMedia also makes a synchronous check that never reaches the handler above.
  // It is given an origin rather than a full URL, so it cannot be narrowed to the path.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    if (clipboard(permission)) return ownPage(origin)
    const bridge = bridgeOrigin()
    return permission === 'media' && !!bridge && origin.startsWith(bridge)
  })
}
