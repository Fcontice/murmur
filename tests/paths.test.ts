import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Electron profile: appData holds the Murmur and Gloop Voice folders.
const electron = vi.hoisted(() => ({ paths: {} as Record<string, string> }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => electron.paths[name],
    setPath: (name: string, value: string) => {
      electron.paths[name] = value
    },
  },
}))

const { dbFile, migrateLegacyData, modelsDir } = await import('../src/main/paths')

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gloop-voice-paths-'))
  const appData = join(root, 'Roaming')
  mkdirSync(appData)
  electron.paths = { appData, userData: join(appData, 'Gloop Voice') }
  vi.stubEnv('LOCALAPPDATA', join(root, 'Local'))
  vi.stubEnv('GLOOP_VOICE_USER_DATA', '')
  vi.stubEnv('GLOOP_VOICE_MODELS_DIR', '')
})

function seedMurmur(): void {
  const profile = join(root, 'Roaming', 'Murmur')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'murmur.sqlite'), 'history')
  writeFileSync(join(profile, 'settings.json'), '{}')
  mkdirSync(join(root, 'Local', 'Murmur', 'models'), { recursive: true })
  writeFileSync(join(root, 'Local', 'Murmur', 'models', 'weights.bin'), 'w')
}

describe('migrateLegacyData', () => {
  it('moves the Murmur profile, database and models to the Gloop Voice folders', () => {
    seedMurmur()
    migrateLegacyData()
    const profile = join(root, 'Roaming', 'Gloop Voice')
    expect(electron.paths.userData).toBe(profile)
    expect(existsSync(join(root, 'Roaming', 'Murmur'))).toBe(false)
    expect(readFileSync(join(profile, 'gloop-voice.sqlite'), 'utf8')).toBe('history')
    expect(existsSync(join(profile, 'settings.json'))).toBe(true)
    expect(dbFile()).toBe(join(profile, 'gloop-voice.sqlite'))
    expect(modelsDir()).toBe(join(root, 'Local', 'Gloop Voice', 'models'))
    expect(existsSync(join(modelsDir(), 'weights.bin'))).toBe(true)
  })

  it('leaves an existing Gloop Voice profile alone', () => {
    seedMurmur()
    mkdirSync(join(root, 'Roaming', 'Gloop Voice'))
    writeFileSync(join(root, 'Roaming', 'Gloop Voice', 'gloop-voice.sqlite'), 'new')
    migrateLegacyData()
    expect(existsSync(join(root, 'Roaming', 'Murmur', 'murmur.sqlite'))).toBe(true)
    expect(readFileSync(dbFile(), 'utf8')).toBe('new')
  })

  it('does nothing on a fresh install', () => {
    migrateLegacyData()
    expect(electron.paths.userData).toBe(join(root, 'Roaming', 'Gloop Voice'))
    expect(modelsDir()).toBe(join(root, 'Local', 'Gloop Voice', 'models'))
  })

  it('never touches the real profile when a scratch profile is set', () => {
    seedMurmur()
    vi.stubEnv('GLOOP_VOICE_USER_DATA', join(root, 'scratch'))
    electron.paths.userData = join(root, 'scratch')
    migrateLegacyData()
    expect(existsSync(join(root, 'Roaming', 'Murmur', 'murmur.sqlite'))).toBe(true)
  })
})
