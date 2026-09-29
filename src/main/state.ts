import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'

/**
 * Nothing about a session survives a restart any more.
 *
 * Ember used to rebuild the previous layout and replay each pane's saved scrollback
 * above its fresh prompt. The replay could only be keyed by layout position — pane ids
 * are regenerated every run — so what came back was whatever had been in that slot last
 * time rather than the tab you remembered, and it was text with no live session behind
 * it: scrolling up reached output whose shell had exited and whose directory might no
 * longer exist. It looked like history and was not.
 *
 * All that is left of it is clearing up after itself.
 */
export function clearLegacyState(): void {
  for (const path of [join(CONFIG_DIR, 'state.json'), join(CONFIG_DIR, 'scrollback')]) {
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    } catch (err) {
      // Leftovers are inert — nothing reads them now. Not worth failing a launch over.
      console.error(`[ember] could not remove ${path}: ${(err as Error).message}`)
    }
  }
}
