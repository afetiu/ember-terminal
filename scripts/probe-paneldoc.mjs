#!/usr/bin/env node
/**
 * Check what `renderPanelDocument` actually produces, without starting Electron.
 *
 * Worth having as its own probe because the risky part of that file is a template
 * literal containing a whole script: a stray backtick or a mis-escaped backslash there
 * produces a document that parses as HTML, loads without complaint, and simply does
 * nothing when you press a button. Compiling the module and then compiling every
 * `<script>` it emits is what turns that into a failure you can see.
 *
 * Run: node scripts/probe-paneldoc.mjs
 */
import { build } from 'vite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
const fail = (msg) => {
  failures++
  console.error(`  ✗ ${msg}`)
}
const pass = (msg) => console.log(`  ✓ ${msg}`)

const out = mkdtempSync(join(tmpdir(), 'ember-paneldoc-'))

/** Compile one module on its own, so nothing else in the app has to be loadable. */
async function load(entry, name) {
  await build({
    logLevel: 'error',
    build: {
      outDir: join(out, name),
      emptyOutDir: true,
      ssr: true,
      lib: { entry, formats: ['es'], fileName: name },
      rollupOptions: { external: ['electron', 'node:fs', 'node:path', 'node:http', 'node:crypto'] },
    },
  })
  return import(pathToFileURL(join(out, name, `${name}.js`)).href)
}

/** Every inline script in the page has to be syntactically valid JavaScript. */
function scriptsCompile(html, where) {
  const bodies = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  if (!bodies.length) return fail(`${where}: no inline script was emitted at all`)
  bodies.forEach((body, i) => {
    try {
      new Function(body)
    } catch (err) {
      fail(`${where}: inline script #${i + 1} does not parse — ${err.message}`)
    }
  })
  pass(`${where}: ${bodies.length} inline script(s) parse`)
}

const push = (over) => ({
  tabId: 'g1',
  title: 'Probe',
  format: 'markdown',
  content: '',
  id: 'abc123',
  at: 0,
  act: 'S3CR3T',
  ...over,
})

const run = async () => {
  const { renderPanelDocument } = await load('src/main/panelDoc.ts', 'panelDoc')

  // 1. A markdown panel carries the runtime and the document secret.
  const md = renderPanelDocument(push({ content: '# Hello\n\nSome *words*.' }))
  scriptsCompile(md, 'markdown')
  md.includes('"S3CR3T"') ? pass('markdown: the act secret reaches the page') : fail('markdown: no act secret')
  md.includes('/panel/act') ? pass('markdown: the page knows where to post') : fail('markdown: no act endpoint')

  // 2. `ember:` links become buttons, and their target survives escaping intact.
  const links = renderPanelDocument(
    push({ content: '[Run it](ember:npm test -- --watch=false & echo done)\n\n[Fill](ember-type:rm -rf dist)' })
  )
  scriptsCompile(links, 'action links')
  links.includes('data-ember-send="npm test -- --watch=false &amp; echo done"')
    ? pass('links: ampersand survives one round trip, escaped once')
    : fail(`links: wrong send target — ${/data-ember-send="[^"]*"/.exec(links)?.[0]}`)
  links.includes('data-ember-submit="0"')
    ? pass('links: ember-type fills without submitting')
    : fail('links: ember-type did not produce a fill-only button')

  // 3. A percent-escaped target decodes, and cannot smuggle markup into the attribute.
  const escaped = renderPanelDocument(push({ content: '[X](ember:say%20%22hi%22%20%3Cb%3E)' }))
  escaped.includes('data-ember-send="say &quot;hi&quot; &lt;b&gt;"')
    ? pass('links: decoded target is re-escaped for the attribute')
    : fail(`links: unsafe or wrong decode — ${/data-ember-send="[^"]*"/.exec(escaped)?.[0]}`)

  // 4. An ask card renders its buttons and its free-text box.
  const ask = renderPanelDocument(
    push({
      format: 'ask',
      content: 'Which one?',
      options: [{ label: 'The first', value: 'go with the first', hint: 'cheaper' }, { label: 'The second' }],
    })
  )
  scriptsCompile(ask, 'ask')
  ask.includes('data-ember-send="go with the first"') ? pass('ask: option value is used') : fail('ask: option value lost')
  ask.includes('data-ember-send="The second"') ? pass('ask: label doubles as value') : fail('ask: bare label lost')
  ask.includes('data-ember-free="ember-free-abc123"')
    ? pass('ask: free-text box is wired to its send button')
    : fail('ask: free-text box missing')

  // 5. A raw html page keeps its own document and still gains the runtime.
  const raw = renderPanelDocument(
    push({ format: 'html', content: '<!doctype html><html><body><h1>Mine</h1></body></html>' })
  )
  scriptsCompile(raw, 'html')
  raw.startsWith('<!doctype html><html><body><h1>Mine</h1>')
    ? pass('html: the page is untouched ahead of the graft')
    : fail('html: the page was rewritten')
  raw.indexOf('__emberDoc') < raw.lastIndexOf('</body>')
    ? pass('html: runtime is grafted inside body')
    : fail('html: runtime landed outside body')

  // 6. A fragment with no body tag still gets one.
  const frag = renderPanelDocument(push({ format: 'html', content: '<p>bare</p>' }))
  scriptsCompile(frag, 'html fragment')

  // 7. Mermaid still boots, and did not lose its own script to the graft.
  const mer = renderPanelDocument(push({ format: 'mermaid', content: 'flowchart LR\n A --> B' }))
  scriptsCompile(mer, 'mermaid')
  mer.includes('/vendor/mermaid.min.js') ? pass('mermaid: loader present') : fail('mermaid: loader missing')

  // 8. The picker is injected as source into a foreign page, so a syntax error in it
  //    would surface as "select mode does nothing on some sites" and nowhere else.
  const pick = await load('src/renderer/src/ui/panelPick.ts', 'panelPick')
  for (const [name, src] of [
    ['PICK_RUNTIME', pick.PICK_RUNTIME],
    ['PICK_STYLE', pick.PICK_STYLE],
  ]) {
    try {
      new Function(src)
      pass(`picker: ${name} parses`)
    } catch (err) {
      fail(`picker: ${name} does not parse — ${err.message}`)
    }
  }
  pick.PICK_RUNTIME.includes('window.__emberPick')
    ? pass('picker: exposes the handle Ember polls')
    : fail('picker: no __emberPick handle')

  writeFileSync(join(out, 'sample.html'), ask)
  console.log(`\nsample ask panel: ${join(out, 'sample.html')}`)
}

run()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} failure(s)`)
      process.exit(1)
    }
    console.log('\npanelDoc OK')
    rmSync(out, { recursive: true, force: true })
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
