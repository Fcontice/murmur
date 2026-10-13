import type { HubApi, PillApi } from '@shared/api'

declare global {
  interface Window {
    murmur: HubApi
    murmurPill: PillApi
  }
}

export {}
