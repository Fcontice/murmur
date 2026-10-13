import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { Settings } from '@shared/types'
import { logger } from './log'
import { userFile } from './paths'

const log = logger('settings')
const ENCRYPTED_PREFIX = 'enc:'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stored values win where their type matches the default; anything else falls back to the default. */
function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(defaults)) {
    if (stored === undefined || stored === null) return defaults
    if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T
    return (defaults === null || typeof stored === typeof defaults ? stored : defaults) as T
  }
  if (!isPlainObject(stored)) return defaults
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaults)) out[key] = mergeDefaults(value, stored[key])
  return out as T
}

function protect(secret: string): string {
  if (!secret || !safeStorage.isEncryptionAvailable()) return secret
  return ENCRYPTED_PREFIX + safeStorage.encryptString(secret).toString('base64')
}

function reveal(stored: string): string {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

export class SettingsStore extends EventEmitter<{ change: [Settings, Settings] }> {
  private readonly file = userFile('settings.json')
  private current: Settings

  constructor() {
    super()
    this.current = this.load()
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    const previous = this.current
    this.current = mergeDefaults(DEFAULT_SETTINGS, { ...previous, ...patch })
    this.save()
    this.emit('change', this.current, previous)
    return this.current
  }

  private load(): Settings {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      const merged = mergeDefaults(DEFAULT_SETTINGS, parsed)
      merged.asrRemote.apiKey = reveal(merged.asrRemote.apiKey)
      merged.llmRemote.apiKey = reveal(merged.llmRemote.apiKey)
      return merged
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Settings unreadable, using defaults', error)
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  private save(): void {
    // API keys are encrypted at rest with the OS credential store.
    const onDisk: Settings = {
      ...this.current,
      asrRemote: { ...this.current.asrRemote, apiKey: protect(this.current.asrRemote.apiKey) },
      llmRemote: { ...this.current.llmRemote, apiKey: protect(this.current.llmRemote.apiKey) },
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(onDisk, null, 2))
      renameSync(temp, this.file)
    } catch (error) {
      log.error('Could not save settings', error)
    }
  }
}
