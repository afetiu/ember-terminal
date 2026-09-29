import { execFile } from 'node:child_process'
import { app } from 'electron'

/**
 * Ask Windows for the fast GPU.
 *
 * On a laptop with two GPUs Windows hands a windowed app the integrated one unless the
 * person has said otherwise in Settings › System › Display › Graphics — and nobody does
 * that for a terminal. Measured on the user's machine: Chromium composited Ember on the Intel
 * Iris Xe while an RTX 4060 idled, and Ember's whole frame is compositing (a 3200x1900
 * acrylic window, a WebGL grid per tab). Chromium offers no switch for this on Windows;
 * the per-app preference is a value under the user's own registry hive, which is exactly
 * what the Settings page writes. It is written once, only if no preference exists — a
 * choice the person made themselves is never overridden — and takes effect on the next
 * launch. Reversible in that same Settings page.
 */
export function preferFastGpu(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
  const exe = process.execPath
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', exe], { windowsHide: true }, (missing) => {
      if (!missing) return resolve(false)
      execFile('reg', ['add', key, '/v', exe, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'], { windowsHide: true }, (err) => {
        if (err) {
          console.warn(`[ember] could not register a GPU preference: ${err.message}`)
          return resolve(false)
        }
        console.log('[ember] registered a high-performance GPU preference')
        resolve(true)
      })
    })
  })
}

/**
 * Registering only counts from the next process, so the very first launch would still
 * run on the slow GPU. This restarts that one launch — before any window exists, so it
 * costs a second and shows nothing — and never twice: the relaunched process carries a
 * marker, and by then the preference exists anyway.
 */
export function relaunchForGpu(): void {
  if (process.argv.includes('--gpu-relaunched')) return
  app.relaunch({ args: [...process.argv.slice(1), '--gpu-relaunched'] })
  app.exit(0)
}

/** Which adapter Chromium is drawing with, for the performance snapshot. */
export async function activeGpu(): Promise<string> {
  try {
    const info = (await app.getGPUInfo('complete')) as { auxAttributes?: { glRenderer?: string } }
    return info.auxAttributes?.glRenderer ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
