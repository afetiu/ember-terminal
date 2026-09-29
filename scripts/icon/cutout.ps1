# Lift a glowing mark off a black plate and crop it tight.
#
#   powershell -File scripts/icon/cutout.ps1 -In emberlogo.png -Out logo-source.png [-Margin 0.06]
#
# The source is a flame rendered on black with soft glow. "Remove the background" for such
# an image is not a colour key — the glow is *made of* partially lit black — so alpha is
# taken from brightness (black → 0, full colour → 255) and the colour un-premultiplied by
# it, which keeps every gradient of the glow as translucency instead of a hard edge. Then
# the bounding box of what is left is found and the image is cropped to it, square, with a
# small margin, so the mark fills the frame at icon sizes.
param(
  [Parameter(Mandatory)] [string]$In,
  [Parameter(Mandatory)] [string]$Out,
  [double]$Margin = 0.06
)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
public static class Cutout {
  // BGRA in, BGRA out. Returns the tight bounding box of alpha > cut as [x0,y0,x1,y1].
  public static int[] Apply(byte[] px, int w, int h, int cut) {
    int x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int i = (y * w + x) * 4;
      int b = px[i], g = px[i + 1], r = px[i + 2];
      int a = Math.Max(r, Math.Max(g, b));
      // Lift the floor a little: the plate is not pure black everywhere.
      a = Math.Max(0, (a - 16) * 255 / 239);
      if (a > 255) a = 255;
      if (a > 0) {
        px[i] = (byte)Math.Min(255, b * 255 / a);
        px[i + 1] = (byte)Math.Min(255, g * 255 / a);
        px[i + 2] = (byte)Math.Min(255, r * 255 / a);
      }
      px[i + 3] = (byte)a;
      if (a > cut) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return new int[] { x0, y0, x1, y1 };
  }

  static void Push(byte[] px, bool[] seen, int[] stack, ref int sp, int p, int open) {
    if (seen[p] || px[p * 4 + 3] >= open) return;
    seen[p] = true;
    stack[sp++] = p;
  }

  // Put a dark plate back under whatever the outside cannot reach.
  //
  // The black-to-alpha pass makes every dark pixel see-through, including the inside of
  // the terminal window, where the prompt glyphs then sit on whatever is behind the icon.
  // The frame is a closed stroke, so a flood fill from the image edges through faint
  // pixels reaches all of the outside and none of the inside; the inside gets an opaque
  // dark fill composited under whatever colour it already had.
  public static void FillEnclosed(byte[] px, int w, int h, int open, byte dr, byte dg, byte db) {
    bool[] outside = new bool[w * h];
    int[] stack = new int[w * h];
    int sp = 0;
    // Mark on push, not on pop, so no pixel is ever queued twice and the stack cannot
    // outgrow the image.
    for (int x = 0; x < w; x++) { Push(px, outside, stack, ref sp, x, open); Push(px, outside, stack, ref sp, (h - 1) * w + x, open); }
    for (int y = 0; y < h; y++) { Push(px, outside, stack, ref sp, y * w, open); Push(px, outside, stack, ref sp, y * w + w - 1, open); }
    while (sp > 0) {
      int p = stack[--sp];
      int x = p % w, y = p / w;
      if (x > 0) Push(px, outside, stack, ref sp, p - 1, open);
      if (x < w - 1) Push(px, outside, stack, ref sp, p + 1, open);
      if (y > 0) Push(px, outside, stack, ref sp, p - w, open);
      if (y < h - 1) Push(px, outside, stack, ref sp, p + w, open);
    }
    for (int p = 0; p < w * h; p++) {
      if (outside[p]) continue;
      int i = p * 4;
      int a = px[i + 3];
      if (a == 255) continue;
      px[i] = (byte)((px[i] * a + db * (255 - a)) / 255);
      px[i + 1] = (byte)((px[i + 1] * a + dg * (255 - a)) / 255);
      px[i + 2] = (byte)((px[i + 2] * a + dr * (255 - a)) / 255);
      px[i + 3] = 255;
    }
  }
}
"@

$src = New-Object System.Drawing.Bitmap $In
$w = $src.Width; $h = $src.Height
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.DrawImage($src, 0, 0, $w, $h); $g.Dispose()
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
# The halo fades to nothing over most of the plate; the crop follows the part that reads
# as the mark (alpha above ~20%), the faint outer glow is kept inside the margin.
$box = [Cutout]::Apply($bytes, $w, $h, 52)
# The inside of the terminal frame goes dark and opaque, so the prompt reads on any
# background. "Open" is the alpha below which a pixel counts as passable for the fill;
# the frame's stroke is far above it.
[Cutout]::FillEnclosed($bytes, $w, $h, 120, 16, 10, 24)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$bmp.UnlockBits($data)

$bw = $box[2] - $box[0] + 1; $bh = $box[3] - $box[1] + 1
$side = [int][Math]::Ceiling([Math]::Max($bw, $bh) * (1 + 2 * $Margin))
$cx = ($box[0] + $box[2]) / 2; $cy = ($box[1] + $box[3]) / 2
$canvas = New-Object System.Drawing.Bitmap $side, $side, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = 'HighQualityBicubic'; $g.CompositingQuality = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
$dx = [int][Math]::Round($side / 2 - $cx); $dy = [int][Math]::Round($side / 2 - $cy)
$g.DrawImage($bmp, $dx, $dy, $w, $h)
$g.Dispose()
$canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"cutout: content ${bw}x${bh} of ${w}x${h} -> ${side}x${side} at $Out"
