/**
 * Publish site/ to Cloudflare Pages (project `ember`, ember.deepanswerlabs.com).
 *
 *   pnpm site:deploy            stamp the version, then deploy
 *   pnpm site:deploy --dry      stamp only
 *
 * The site has no build step, so the two things that must follow each release are
 * stamped here from package.json before upload: the version the page advertises
 * (`VERSION` in site/main.js) and the `?v=` query on every asset link, which is what
 * makes browsers fetch the new styles and scripts instead of their cached copies. Both
 * were edited by hand before, and the page went on saying v1.0.0 for three releases.
 *
 * The project is not connected to the repository — a push changes nothing on the site.
 * Needs `wrangler login` on this machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

function stamp(file, edits) {
  const url = new URL(file, root)
  const before = readFileSync(url, 'utf8')
  let after = before
  for (const [re, to] of edits) after = after.replace(re, to)
  if (after !== before) writeFileSync(url, after, 'utf8')
  console.log(`${after === before ? 'unchanged' : 'stamped  '} ${file}`)
}

stamp('site/main.js', [[/const VERSION = '[^']*'/, `const VERSION = '${version}'`]])
// The query carries a hash of the assets as well as the version. Cloudflare's edge keeps
// a script for hours under its full URL, query included, so a second deploy of the same
// version served the first one's main.js until the hash made the URL new.
const hash = createHash('sha1')
for (const f of ['main.js', 'film.js', 'docs.js', 'styles.css', 'docs.css']) {
  const url = new URL(`site/${f}`, root)
  if (existsSync(url)) hash.update(readFileSync(url))
}
const tag = `${version}-${hash.digest('hex').slice(0, 8)}`
for (const page of ['site/index.html', 'site/docs.html']) stamp(page, [[/\?v=[0-9][0-9a-z.-]*/g, `?v=${tag}`]])
console.log(`site is v${version} (assets ${tag})`)

if (!process.argv.includes('--dry')) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  // Through the shell, because npx is a .cmd on Windows — so an argument with a space in
  // it carries its own quotes.
  execFileSync(
    'npx',
    ['--yes', 'wrangler@4', 'pages', 'deploy', 'site', '--project-name=ember', '--branch=main', `--commit-hash=${commit}`, `"--commit-message=Ember ${version}"`],
    { cwd: root, stdio: 'inherit', shell: true }
  )
}
