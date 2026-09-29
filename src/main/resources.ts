import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Where the files that ship beside the code live.
 *
 * Two of them cannot go through the bundler: `mcp-panel.mjs` is executed by Claude
 * Code as its own process, and mermaid is a 3MB library the panel loads over HTTP.
 * Both are copied verbatim by electron-builder's `extraResources`, which puts them
 * under `process.resourcesPath` in a packaged app and nowhere at all in a dev run —
 * hence the two candidates.
 */
export function resourcePath(...parts: string[]): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources', ...parts),
    join(app.getAppPath(), 'resources', ...parts),
    join(__dirname, '../../resources', ...parts),
  ]
  return candidates.find((p) => existsSync(p)) ?? (candidates[1] as string)
}
