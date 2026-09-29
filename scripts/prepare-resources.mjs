import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage the files that ship beside the bundle rather than inside it.
 *
 * Mermaid is a devDependency on purpose — nothing in main or the renderer imports it,
 * so bundling it would be dead weight. The panel loads it over HTTP from the bridge,
 * which means one file has to exist on disk in the packaged app. Copying it here keeps
 * the version tied to the lockfile instead of to a checked-in blob nobody updates.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'vendor')

const files = [
  ['node_modules/mermaid/dist/mermaid.min.js', 'mermaid.min.js'],
]

mkdirSync(out, { recursive: true })
for (const [from, to] of files) {
  const src = join(root, from)
  if (!existsSync(src)) {
    // A missing vendor file degrades a feature, it does not break the build: diagrams
    // fall back to showing their source.
    console.warn(`[ember] resources: ${from} is missing, skipping`)
    continue
  }
  copyFileSync(src, join(out, to))
  console.log(`[ember] resources: ${to}`)
}
