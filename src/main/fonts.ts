import { execFile } from 'node:child_process'
import type { FontOption } from '../shared/types.js'

/**
 * Font families installed on this machine, for the settings font picker.
 *
 * Chromium has no API for this that does not go through a permission prompt, so the
 * list comes from the OS: GDI's installed collection on Windows, fontconfig
 * elsewhere. Enumeration is slow enough to be worth caching (a few hundred families
 * through a PowerShell start-up), and fonts do not come and go while the app runs.
 */

/**
 * Stacks worth offering even when the machine has none of them installed — they are
 * the ones the defaults and the shipped themes assume. Merged into whatever the OS
 * reports so the picker is never empty, and so the currently configured font always
 * has a row even on a fresh machine.
 */
const BUILT_IN = [
  'CaskaydiaCove NF',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Fira Code',
  'JetBrains Mono',
  'Hack',
  'IBM Plex Mono',
  'Source Code Pro',
  'Courier New',
  'Lucida Console',
  'MesloLGS NF',
  'Segoe UI',
  'Segoe UI Variable',
  'Inter',
  'Arial',
  'monospace',
]

const WIN_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '[System.Drawing.FontFamily]::Families | ForEach-Object { $_.Name }',
].join('; ')

/** CSS keywords rather than families: always resolvable, never in the OS list. */
const GENERIC = new Set(['monospace', 'sans-serif', 'serif'])

let cache: FontOption[] | null = null
let inflight: Promise<FontOption[]> | null = null

/** Case-insensitive dedupe, then a stable alphabetical order. */
function normalise(names: string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (!seen.has(key)) seen.set(key, name)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        // A machine whose shell is wedged must not hang the settings panel; the
        // built-in list is a perfectly usable answer.
        { timeout: 6000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err && !stdout ? '' : stdout),
      )
    } catch {
      resolve('')
    }
  })
}

async function enumerate(): Promise<string[]> {
  if (process.platform === 'win32') {
    // -EncodedCommand sidesteps every quoting rule the command line would apply.
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
    return out.split(/\r?\n/)
  }
  // fontconfig prints "Family,Localised Family", backslash-escaping punctuation in
  // the name. The first name, unescaped, is the one CSS wants.
  const out = await run('fc-list', [':', 'family'])
  return out.split(/\r?\n/).map((line) => (line.split(',')[0] ?? '').replace(/\\(.)/g, '$1'))
}

export async function listFonts(): Promise<FontOption[]> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = enumerate()
    .catch(() => [])
    .then((found) => {
      const real = new Set(normalise(found).map((f) => f.toLowerCase()))
      // Nothing came back: the OS would not say, which is not the same as "you have
      // none of these". Claiming a font is missing on no evidence is worse than
      // staying quiet, so everything is left unmarked.
      const blind = real.size === 0
      cache = normalise([...found, ...BUILT_IN]).map((family) => ({
        family,
        installed: blind || real.has(family.toLowerCase()) || GENERIC.has(family.toLowerCase()),
      }))
      inflight = null
      return cache
    })
  return inflight
}
