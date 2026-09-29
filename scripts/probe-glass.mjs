/**
 * probe-glass.mjs — is the terminal actually see-through, focused and unfocused?
 *
 * The glass is the one part of Ember that cannot be checked from inside the app: the
 * blur is drawn by DWM, below the window, so `capturePage` sees nothing but the
 * renderer's own tint. This probe screenshots the *desktop* instead, with a window of
 * four flat colour blocks sitting behind Ember's window, and reads the pixels back.
 *
 *   - blocks legible through the window  → transparent, no blur (material 'none')
 *   - blocks smeared but still coloured  → acrylic; DWM is blurring the desktop
 *   - one flat grey                      → solid: the window is a slab
 *
 * Colour blocks, not a checkerboard: a fine pattern averages to flat grey under a
 * blur, which is pixel-for-pixel what the failure looks like.
 *
 *   node scripts/probe-glass.mjs                 # the shipped defaults
 *   node scripts/probe-glass.mjs --material none
 *   node scripts/probe-glass.mjs --keep          # leave the PNGs on disk
 *
 * Findings this locks in (Windows 11 26200, Electron 43):
 *   - acrylic focused        → blur, colours read through
 *   - acrylic unfocused      → #363439 slab, every sample identical. DWM policy: no
 *                              system backdrop is drawn for an inactive window, and
 *                              re-setting the material, a timer and the legacy
 *                              SetWindowCompositionAttribute path were all tried.
 *   - accent blur-behind     → paints the region *black* on this build, focused or
 *                              not. The Win10-era workaround is gone; don't re-derive.
 *   - acrylic + inactive fade→ colours read through again, unfocused. That is the fix
 *                              that ships (config `window.inactiveOpacity`).
 *
 * Also measured and dead, so nobody spends another evening on them. Both were run with
 * GetForegroundWindow read alongside every sample — without that check a run is
 * worthless, because a probe window that quietly kept the foreground blurs anyway and
 * reads as a false positive:
 *   - activation spoofing    → WM_NCACTIVATE(TRUE) and WM_ACTIVATE(WA_ACTIVE), single
 *                              and hammered, sent to an inactive acrylic window. No
 *                              blur. A single WM_NCACTIVATE makes the window drop out
 *                              of composition entirely — the samples come back as the
 *                              *raw* backdrop colours, which is a vanished window, not
 *                              a blurred one. Easy to misread as success.
 *   - every ACCENT_STATE     → BLURBEHIND(3), ACRYLICBLURBEHIND(4), HOSTBACKDROP(5) and
 *                              TRANSPARENTGRADIENT(2) applied to an inactive window all
 *                              return the identical 43,35,57 slab: the accent policy
 *                              does not override DWMWA_SYSTEMBACKDROP_TYPE at all.
 * DWM decides this above the app. The only route left is hosting a WinUI
 * DesktopAcrylicController and holding SystemBackdropConfiguration.IsInputActive true,
 * which needs a native WinRT module — a different kind of project, not a tweak.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, screen } from 'electron'

const run = promisify(execFile)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? true)
}
const MATERIAL = String(flag('material', 'acrylic'))
const INACTIVE = Number(flag('inactive', 72))
const KEEP = argv.includes('--keep')
const OUT = mkdtempSync(join(tmpdir(), 'ember-glass-'))

const BACKDROP = `data:text/html,${encodeURIComponent(`
<body style="margin:0;height:100vh;display:grid;grid-template:1fr 1fr/1fr 1fr">
  <div style="background:#ff2d2d"></div><div style="background:#22ff5a"></div>
  <div style="background:#2d6bff"></div><div style="background:#ffe11a"></div>
</body>`)}`

const GLASS = `data:text/html,${encodeURIComponent(`
<body style="margin:0;height:100vh;background:rgba(26,14,46,0.7);
  font:600 18px monospace;color:#d9d2ea;display:grid;place-items:center">ember</body>`)}`

/** Screenshot the desktop and read four pixels back, one per colour block. */
const SAMPLE = (rect, save) => `
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
${save ? `$bmp.Save('${save.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)` : ''}
$pts = @(@(${rect.x + rect.w * 0.2}, ${rect.y + rect.h * 0.2}), @(${rect.x + rect.w * 0.8}, ${rect.y + rect.h * 0.2}),
         @(${rect.x + rect.w * 0.2}, ${rect.y + rect.h * 0.8}), @(${rect.x + rect.w * 0.8}, ${rect.y + rect.h * 0.8}))
($pts | ForEach-Object { $p = $bmp.GetPixel([int]$_[0], [int]$_[1]); "$($p.R),$($p.G),$($p.B)" }) -join ' | '
$bmp.Dispose()
`

const ps = (script) =>
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    maxBuffer: 1 << 24,
  })

const sample = async (rect, name) =>
  (await ps(SAMPLE(rect, KEEP ? join(OUT, `${name}.png`) : null))).stdout.trim()
const rgb = (s) => s.split(' | ').map((p) => p.split(',').map(Number))
/** Spread between the samples: high = the desktop reads through, ~0 = a slab. */
const spread = (s) => {
  const pts = rgb(s)
  const chan = (i) => Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i]))
  return Math.max(chan(0), chan(1), chan(2))
}

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  ${detail}`)
}

void app
  .whenReady()
  .then(async () => {
    // Both windows are topmost, so nothing on the desktop can drift *between* them —
    // measure what leaks through the glass and you must know what is behind it.
    const backdrop = new BrowserWindow({
      x: 160,
      y: 140,
      width: 940,
      height: 600,
      title: 'probe backdrop',
      alwaysOnTop: true,
    })
    await backdrop.loadURL(BACKDROP)

    const bounds = { x: 300, y: 250, width: 620, height: 360 }
    const glass = new BrowserWindow({
      ...bounds,
      frame: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      ...(MATERIAL === 'none' ? { transparent: true } : { backgroundMaterial: MATERIAL }),
    })
    await glass.loadURL(GLASS)
    glass.moveTop()

    // Screenshots are in physical pixels; window bounds are in DIP.
    const s = screen.getPrimaryDisplay().scaleFactor
    const rect = { x: bounds.x * s, y: bounds.y * s, w: bounds.width * s, h: bounds.height * s }

    glass.focus()
    await wait(900)
    const focused = await sample(rect, 'focused')
    check(`${MATERIAL}: focused is see-through`, spread(focused) > 20, focused)

    // Deactivate. This is the case the whole feature exists for. moveTop restores the
    // z-order the focus change just inverted, without handing focus back.
    backdrop.focus()
    await wait(500)
    glass.moveTop()
    await wait(900)
    const bare = await sample(rect, 'unfocused-bare')
    const bareOk = MATERIAL === 'none' ? spread(bare) > 20 : spread(bare) < 12
    check(`${MATERIAL}: unfocused without the fade`, bareOk, `${bare}${MATERIAL === 'none' ? '' : '  (DWM slab, as documented)'}`)

    if (MATERIAL !== 'none') {
      glass.setOpacity(INACTIVE / 100)
      await wait(400)
      const faded = await sample(rect, 'unfocused-faded')
      check(`${MATERIAL}: unfocused at inactiveOpacity ${INACTIVE}`, spread(faded) > 20, faded)
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nglass holds, focused and not')
    if (KEEP) console.log(`artifacts: ${OUT}`)
    else rmSync(OUT, { recursive: true, force: true })
    app.exit(failures ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    app.exit(1)
  })
