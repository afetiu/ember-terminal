/// <reference types="vite/client" />

import type { EmberBridge } from '@shared/types'

declare global {
  interface Window {
    ember: EmberBridge
  }
}

export {}
