import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * Two lines of @xterm/addon-webgl, changed at build time. Both only matter on a light
 * theme; each throws if its shape changes, so an upgrade cannot drop a fix silently.
 *
 * 1. The renderer fills a rectangle behind every cell whose background word is non-zero,
 *    and the dim, italic and underline-style flags live in that word — so a dim cell on
 *    the default background got a rectangle in the theme background at alpha 1, whatever
 *    the colour's own alpha. Ember's grid is transparent (the window paints the ground),
 *    so that was an opaque block: black boxes behind every dimmed line of Claude Code on
 *    a light theme. Here the default background keeps its own alpha, which is zero.
 *
 * 2. Contrast correction holds dim text to half the ratio, measured on the colour before
 *    dimming, and the cell is then drawn at half opacity on top — ~1.5:1 on paper. Here
 *    dim text is drawn as an opaque half-blend into the ground, held to two thirds of the
 *    ratio: still visibly dim, still readable. With the floor at 1 (every
 *    dark theme) the correction never runs and nothing changes.
 */
const PATCHES: { what: string; shape: RegExp; to: (...g: string[]) => string }[] = [
  {
    what: 'default-background alpha',
    shape: /([\w$]+)=\(([\w$]+)>>8&255\)\/255,([\w$]+)=1,this\._addRectangle\(/,
    to: (_m, b, rgba, a) =>
      `${b}=(${rgba}>>8&255)/255,${a}=${rgba}===this._themeService.colors.background.rgba?(${rgba}&255)/255:1,this._addRectangle(`,
  },
  {
    what: 'dim contrast',
    shape:
      /([\w$]+)=this\._resolveForegroundRgba\(([^)]*)\),([\w$]+)=([\w$]+)\.ensureContrastRatio\(([\w$]+),\1,this\._config\.minimumContrastRatio\/\(([\w$]+)\?2:1\)\)/,
    to: (_m, fg, args, out, lib, bg, dim) =>
      // Inside a `let` list, so the blend is an arrow over the resolved colour, not a reassignment.
      `${fg}=(($v)=>${dim}?((((${bg}>>>24)+($v>>>24))>>>1)<<24|(((${bg}>>>16&255)+($v>>>16&255))>>>1)<<16|(((${bg}>>>8&255)+($v>>>8&255))>>>1)<<8|255)>>>0:$v)(this._resolveForegroundRgba(${args})),` +
      // A dim colour that already passes is returned as the opaque blend too: xterm's own
      // half-alpha glyph comes out far fainter on paper than the blend it stands for.
      `${out}=${lib}.ensureContrastRatio(${bg},${fg},this._config.minimumContrastRatio/(${dim}?1.5:1))||(${dim}?${fg}:void 0)`,
  },
]

function patchXtermWebgl(): Plugin {
  return {
    name: 'ember:patch-xterm-webgl',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!/@xterm[\/]addon-webgl[\/]lib[\/]addon-webgl\.m?js$/.test(id.split('?')[0]!)) return null
      for (const p of PATCHES) {
        if (!p.shape.test(code)) throw new Error(`addon-webgl changed shape: re-check the ${p.what} patch`)
        code = code.replace(p.shape, p.to as (...g: string[]) => string)
      }
      return code
    },
  }
}

export default defineConfig({
  main: {
    // @lydell/node-pty is a prebuilt N-API binary — it must stay external and be
    // require()'d at runtime, never bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `overlay` is the cursor window's preload: three calls, none of `window.ember`.
      input: { index: resolve('src/preload/index.ts'), overlay: resolve('src/preload/overlay.ts') },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [patchXtermWebgl()],
    // Pre-bundling would hand dev mode an unpatched copy.
    optimizeDeps: { exclude: ['@xterm/addon-webgl'] },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src'),
      },
    },
    build: {
      target: 'chrome140',
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
})
