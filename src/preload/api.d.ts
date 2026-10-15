import type { HubApi, PillApi } from '@shared/api'

declare global {
  interface Window {
    gloopVoice: HubApi
    gloopVoicePill: PillApi
  }
}

export {}
