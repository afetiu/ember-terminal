import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

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
