import { session, type WebContents } from 'electron'

/**
 * What web content in Ember may ask for.
 *
 * Nothing gets the microphone: Ember has no speech of its own. The app's own page (file://) may read the
 * clipboard for Ctrl+V; nothing loaded from the bridge may, because panel documents carry
 * model-authored markup. The page also has to be a top-level window's: a panel <webview>
 * cannot be file:// today (main rewrites its src), but if one ever were, it would still
 * be model content and still get nothing — and a frame inside the page gets nothing either.
 */
export function registerPermissions(): void {
  const ownPage = (url: string) => url.startsWith('file://')
  const ownWindow = (wc: WebContents | null) => !!wc && wc.getType() === 'window'
  const clipboard = (permission: string) => permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(clipboard(permission) && ownWindow(wc) && details.isMainFrame !== false && ownPage(details?.requestingUrl ?? ''))
  })
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission, origin, details) =>
      clipboard(permission) && ownWindow(wc) && details.isMainFrame !== false && ownPage(origin),
  )
}
