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
// The phone app's object frames load the same libraries from the site (docs/specs/phone.md).
const site = join(root, 'site', 'vendor')

const files = [
  ['node_modules/mermaid/dist/mermaid.min.js', 'mermaid.min.js'],
  // PDFs on the canvas are drawn with pdf.js: no plugin, which a sandboxed frame would not load.
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  // Each look's faces, for documents and diagrams drawn in it (served by the bridge;
  // the list is DOC_FONTS in src/main/panelDoc.ts).
  ...[
    'archivo-latin-400',
    'archivo-latin-500',
    'archivo-latin-700',
    'archivo-latin-800',
    'dm-mono-latin-400',
    'dm-mono-latin-500',
    'geist-latin-wght',
    'geist-mono-latin-wght',
    'outfit-latin-wght',
    'red-hat-mono-latin-wght',
    'bricolage-grotesque-latin-wght',
    'martian-mono-latin-wght',
    'hanken-grotesk-latin-wght',
    'jetbrains-mono-latin-wght',
    'fredoka-latin-wght',
  ].map((f) => [
    `src/renderer/src/assets/fonts/${f}-normal.woff2`,
    `${f}-normal.woff2`,
  ]),
]

mkdirSync(out, { recursive: true })
mkdirSync(site, { recursive: true })
for (const [from, to] of files) {
  const src = join(root, from)
  if (!existsSync(src)) {
    // A missing vendor file degrades a feature, it does not break the build: diagrams
    // fall back to showing their source.
    console.warn(`[ember] resources: ${from} is missing, skipping`)
    continue
  }
  copyFileSync(src, join(out, to))
  copyFileSync(src, join(site, to))
  console.log(`[ember] resources: ${to}`)
}
