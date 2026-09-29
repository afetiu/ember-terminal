/**
 * The app icon, from a square PNG.
 *
 * The icon used to be rendered from icon.html; it is now a supplied picture, so this
 * takes that picture and produces everything Windows and electron-builder ask for: PNGs
 * at 16 through 1024 with rounded transparent corners, and a multi-resolution .ico with
 * a complete PNG per entry (accepted since Vista; no DIB masks to hand-roll).
 *
 *   node scripts/icon/from-png.mjs <source.png>
 *
 * Resizing goes through System.Drawing in PowerShell, because node has no image codec of
 * its own and this repo has no reason to take one on for a job done once per logo.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../build')
const src = process.argv[2]
if (!src) {
  console.error('usage: node scripts/icon/from-png.mjs <source.png>')
  process.exit(2)
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const PNG_SIZES = [256, 512, 1024]
const all = [...new Set([...ICO_SIZES, ...PNG_SIZES])].sort((a, b) => a - b)
const work = join(outDir, 'iconsrc')
mkdirSync(work, { recursive: true })

const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${resolve(src).replace(/'/g, "''")}')
foreach ($s in ${all.join(',')}) {
  $dst = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  $r = [Math]::Round($s * 0.22); $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0,0,$r*2,$r*2,180,90); $path.AddArc($s-$r*2,0,$r*2,$r*2,270,90); $path.AddArc($s-$r*2,$s-$r*2,$r*2,$r*2,0,90); $path.AddArc(0,$s-$r*2,$r*2,$r*2,90,90); $path.CloseFigure()
  $g.SetClip($path)
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $dst.Save((Join-Path '${work.replace(/'/g, "''")}' "icon-$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()
}
`
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit', windowsHide: true })
if (r.status !== 0) process.exit(r.status ?? 1)

function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  images.forEach(({ size, data }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

const png = (s) => readFileSync(join(work, `icon-${s}.png`))
writeFileSync(join(outDir, 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, data: png(size) }))))
for (const s of PNG_SIZES) copyFileSync(join(work, `icon-${s}.png`), join(outDir, `icon-${s}.png`))
copyFileSync(join(work, 'icon-1024.png'), join(outDir, 'icon.png'))
rmSync(work, { recursive: true, force: true })
console.log(`wrote build/icon.ico (${ICO_SIZES.join('/')}) and build/icon-{${PNG_SIZES.join(',')}}.png from ${src}`)
