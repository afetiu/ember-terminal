import { session } from 'electron'

/**
 * What web content in Ember may ask for.
 *
 * Nothing gets the microphone: Ember has no speech of its own any more (the voice call
 * needed API keys, and Ember takes none). The app's own page (file://) may read the
 * clipboard for Ctrl+V; nothing loaded from the bridge may, because panel documents carry
 * model-authored markup.
 */
export function registerVoice(): void {
  const ownPage = (url: string) => url.startsWith('file://')
  const clipboard = (permission: string) => permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(clipboard(permission) && ownPage(details?.requestingUrl ?? ''))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => clipboard(permission) && ownPage(origin))
}
