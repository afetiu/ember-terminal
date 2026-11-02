/// <reference types="vite/client" />

import type { EmberBridge } from '@shared/types'

declare global {
  interface Window {
    ember: EmberBridge
  }
  /** package.json's version, baked in at build time (electron.vite.config.ts). */
  const __EMBER_VERSION__: string
}

export {}
