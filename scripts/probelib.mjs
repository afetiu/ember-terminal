/**
 * A probe's own EMBER_HOME, ready to boot straight to a shell.
 *
 * A fresh EMBER_HOME is a new install, and a new install opens to the first-run desk with
 * no tab in it — so a probe that waits for a session waits for ever. This marks the home
 * as onboarded (and keeps the brain sync off), merged into whatever config.json the probe
 * has already written, so the probe's own settings stand. probe-firstrun.mjs is the one
 * probe that wants the first run, and does not call this.
 *
 *   import { seedHome } from './probelib.mjs'
 *   seedHome(EMBER_HOME)        // after writing config.json, before spawning Electron
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function seedHome(home) {
  mkdirSync(home, { recursive: true })
  const file = join(home, 'config.json')
  let cfg = {}
  try {
    if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    cfg = {}
  }
  cfg.agent = { ...(cfg.agent ?? {}), onboarded: true }
  cfg.brain = { ...(cfg.brain ?? {}), sync: false }
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  return home
}

/**
 * The renderer page to drive: the Ember already listening on EMBER_CDP_PORT when that is
 * set (a diagnostic run against the app you are looking at), otherwise a dev Ember of the
 * probe's own — its own EMBER_HOME, shown inactive — on `port`. `done()` closes what was
 * launched and leaves an attached Ember alone.
 */
export async function emberPage(name, port, { bounds } = {}) {
  const attach = process.env['EMBER_CDP_PORT']
  let child = null
  const at = attach ? Number(attach) : port
  if (!attach) {
    const { spawn } = await import('node:child_process')
    const home = seedHome(join(process.env.TEMP ?? '.', `ember-probe-${name}`))
    const repo = new URL('..', import.meta.url).pathname.slice(1).replace(/\/$/, '')
    child = spawn(join(repo, 'node_modules/electron/dist/electron.exe'), ['.', `--remote-debugging-port=${at}`], {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, EMBER_HOME: home, EMBER_PROBE_INACTIVE: '1', ...(bounds ? { EMBER_PROBE_BOUNDS: bounds } : {}) },
    })
    // The probe ends when its own work does; the launched Ember goes with it.
    child.unref()
    process.on('exit', () => done())
  }
  let page = null
  for (let i = 0; i < 80 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${at}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://')) ?? null
    } catch {
      /* not up yet */
    }
    if (!page) await new Promise((r) => setTimeout(r, 400))
  }
  if (!page) {
    child?.kill()
    throw new Error(`no Ember renderer on port ${at}`)
  }
  // A launched Ember needs its first tab before there is anything to measure.
  if (child) await new Promise((r) => setTimeout(r, 4000))
  function done() {
    if (!child) return
    const { spawnSync } = process.getBuiltinModule('node:child_process')
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child = null
  }
  return { page, port: at, launched: !attach, done }
}
