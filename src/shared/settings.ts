import type { Settings, ShortcutAction } from './types'

export const VK = {
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  win: 0x5b,
  space: 0x20,
  escape: 0x1b,
  enter: 0x0d,
} as const

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, number[]> = {
  ptt: [VK.ctrl, VK.win],
  handsFree: [VK.ctrl, VK.win, VK.space],
  command: [VK.ctrl, VK.win, VK.alt],
  pasteLast: [VK.shift, VK.alt, 0x5a],
  cancel: [VK.escape],
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  shortcuts: DEFAULT_SHORTCUTS,
  microphoneId: null,
  keepMicWarm: false,
  sounds: true,
  showPillWhenIdle: true,
  launchAtLogin: false,
  theme: 'dark',

  asrProvider: 'local',
  asrModel: 'parakeet-tdt-0.6b-v3',
  asrRemote: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'whisper-1' },
  language: 'auto',

  llmProvider: 'local',
  llmModel: 'gemma-3-4b-it',
  llmRemote: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'gemma3:4b' },

  editingStrength: 'light',
  styles: { personal: 'casual', work: 'casual', email: 'formal', other: 'formal' },
  smartSpacing: true,
  voiceCommands: true,
  useAppContext: true,
  searchUrl: 'https://www.google.com/search?q={query}',

  pasteMethod: 'clipboard',
  restoreClipboard: true,
  clipboardRestoreDelayMs: 350,

  saveHistory: true,
  historyRetentionDays: 0,
}

const MODIFIERS: number[] = [VK.ctrl, VK.shift, VK.alt, VK.win]

const KEY_LABELS: Record<number, string> = {
  [VK.ctrl]: 'Ctrl',
  [VK.shift]: 'Shift',
  [VK.alt]: 'Alt',
  [VK.win]: 'Win',
  [VK.space]: 'Space',
  [VK.escape]: 'Esc',
  [VK.enter]: 'Enter',
  0x08: 'Backspace',
  0x09: 'Tab',
  0x14: 'Caps Lock',
  0x21: 'Page Up',
  0x22: 'Page Down',
  0x23: 'End',
  0x24: 'Home',
  0x25: 'Left',
  0x26: 'Up',
  0x27: 'Right',
  0x28: 'Down',
  0x2d: 'Insert',
  0x2e: 'Delete',
  0xba: ';',
  0xbb: '=',
  0xbc: ',',
  0xbd: '-',
  0xbe: '.',
  0xbf: '/',
  0xc0: '`',
  0xdb: '[',
  0xdc: '\\',
  0xdd: ']',
  0xde: "'",
}

export function keyLabel(vk: number): string {
  const known = KEY_LABELS[vk]
  if (known) return known
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a)) return String.fromCharCode(vk)
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`
  if (vk >= 0x60 && vk <= 0x69) return `Num ${vk - 0x60}`
  return `Key ${vk}`
}

/** Modifiers first in a fixed order, then the remaining keys. */
export function sortKeys(keys: number[]): number[] {
  const rank = (vk: number) => (MODIFIERS.includes(vk) ? MODIFIERS.indexOf(vk) : MODIFIERS.length + vk)
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b))
}

export function shortcutLabel(keys: number[]): string {
  return sortKeys(keys).map(keyLabel).join(' + ')
}

/** Returns a reason the chord cannot be used, or null when it is fine. */
export function validateShortcut(action: ShortcutAction, keys: number[]): string | null {
  if (keys.length === 0) return 'Press at least one key.'
  if (action === 'cancel') return keys.length === 1 ? null : 'Cancel must be a single key.'
  if (keys.length > 4) return 'Use four keys or fewer.'
  if (!keys.some((key) => MODIFIERS.includes(key))) return 'Include Ctrl, Alt, Shift or Win so normal typing does not trigger it.'
  if (keys.length === 1) return 'Use at least two keys.'
  return null
}

export function sameKeys(a: number[], b: number[]): boolean {
  return a.length === b.length && sortKeys(a).every((key, index) => key === sortKeys(b)[index])
}

export const SEARCH_ENGINES: Array<{ name: string; url: string }> = [
  { name: 'Google', url: 'https://www.google.com/search?q={query}' },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
  { name: 'Bing', url: 'https://www.bing.com/search?q={query}' },
]

/** Returns a reason the search URL cannot be used, or null when it is fine. */
export function validateSearchUrl(url: string): string | null {
  if (!url.includes('{query}')) return 'The search URL must contain {query} where the search terms go.'
  try {
    const parsed = new URL(url.replace('{query}', 'test'))
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'The search URL must start with https:// or http://.'
  } catch {
    return 'That is not a valid web address.'
  }
  return null
}
