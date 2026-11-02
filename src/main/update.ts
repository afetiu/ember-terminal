import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, shell } from 'electron'
import type { UpdateState } from '../shared/types.js'

/**
 * Ember updates itself from its own GitHub releases.
 *
 * It asks the releases API which version is latest — at start and every few hours — and
 * when that is newer than this build, the version at the foot of the sidebar becomes an
 * Update button. Installing downloads the same installer the website links to, checks it
 * against the release's SHA256SUMS.txt (as site/install.ps1 does), runs it silently with
 * `--force-run` so the new version starts by itself, and quits to let it replace the
 * files. A portable copy (unzipped, no installer of its own) cannot be replaced that way:
 * for it the button opens the download page instead.
 *
 * No dependency: electron-updater would need extra files in every release and the release
 * workflow publishes with `--publish never`.
 */

const REPO = 'afetiu/ember-terminal'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const DOWNLOAD = `https://github.com/${REPO}/releases/latest/download`
const SETUP = 'Ember-Setup-win-x64.exe'
const SITE = 'https://ember.deepanswerlabs.com'
/** The first look waits for the window to settle; after that, a few times a day is plenty. */
const FIRST_MS = 20_000
const EVERY_MS = 6 * 60 * 60_000

/** 1.4.10 > 1.4.9: compared number by number, not as text. */
function newer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

export class Updater {
  state: UpdateState
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly emit: (s: UpdateState) => void) {
    this.state = { current: app.getVersion(), latest: null, available: false, installed: Updater.installedCopy(), phase: 'idle', error: '', checkedAt: 0 }
    // A dev build is not a release: it never offers to replace itself.
    if (!app.isPackaged) return
    this.timer = setTimeout(() => void this.check(), FIRST_MS)
  }

  /** Installed by the NSIS installer (it leaves its uninstaller next to the exe), not unzipped. */
  private static installedCopy(): boolean {
    return app.isPackaged && existsSync(join(dirname(process.execPath), 'Uninstall Ember.exe'))
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit(this.state)
  }

  /** Ask which release is latest. Quiet on failure: the next look tries again. */
  async check(): Promise<UpdateState> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.check(), EVERY_MS)
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') return this.state
    this.set({ phase: 'checking', error: '' })
    try {
      const r = await fetch(LATEST, { headers: { 'user-agent': `ember/${app.getVersion()}`, accept: 'application/vnd.github+json' } })
      if (!r.ok) throw new Error(`GitHub said ${r.status}`)
      const tag = String(((await r.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '')
      this.set({ phase: 'idle', latest: tag || null, available: !!tag && newer(tag, this.state.current), checkedAt: Date.now() })
    } catch (err) {
      this.set({ phase: 'idle', checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) })
    }
    return this.state
  }

  /** Download, check, install silently and restart into the new version. */
  async install(): Promise<void> {
    if (!this.state.available || this.state.phase === 'downloading' || this.state.phase === 'installing') return
    if (!this.state.installed) {
      void shell.openExternal(SITE)
      return
    }
    try {
      this.set({ phase: 'downloading', error: '' })
      const [exe, sums] = await Promise.all([fetch(`${DOWNLOAD}/${SETUP}`), fetch(`${DOWNLOAD}/SHA256SUMS.txt`)])
      if (!exe.ok || !sums.ok) throw new Error(`the download failed (${exe.status}, ${sums.status})`)
      const bytes = Buffer.from(await exe.arrayBuffer())
      const line = (await sums.text()).split('\n').find((l) => l.includes(SETUP))
      const want = line?.trim().split(/\s+/)[0]?.toLowerCase()
      const got = createHash('sha256').update(bytes).digest('hex')
      if (!want || want !== got) throw new Error('the download does not match the release checksum')
      const dir = join(app.getPath('temp'), `ember-update-${this.state.latest ?? 'latest'}`)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, SETUP)
      writeFileSync(file, bytes)
      this.set({ phase: 'installing' })
      // Detached, so it outlives this process; --force-run starts the new Ember when done.
      spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      setTimeout(() => app.quit(), 600)
    } catch (err) {
      this.set({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
  }
}
