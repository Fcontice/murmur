import { app } from 'electron'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const isDev = !app.isPackaged

/** The app was called Murmur until October 2026; its folders are moved over on first launch. */
const LEGACY_NAME = 'Murmur'
const LEGACY_DB = 'murmur.sqlite'
const DB_FILE = 'gloop-voice.sqlite'

export function userFile(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

/** Falls back to the Murmur file name when it could not be renamed, so history is never split. */
export function dbFile(): string {
  const current = userFile(DB_FILE)
  const legacy = userFile(LEGACY_DB)
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

/** Moves `from` to `to` unless `to` exists. Returns false when the move failed (e.g. Murmur is still running). */
function moveIfFresh(from: string, to: string): boolean {
  if (existsSync(to) || !existsSync(from)) return true
  try {
    renameSync(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * Must run before the single-instance lock and app ready, which both create the profile folder.
 * If a folder cannot be moved the app keeps using the Murmur one and tries again next launch.
 */
export function migrateLegacyData(): void {
  if (!process.env.GLOOP_VOICE_USER_DATA) {
    const legacy = join(app.getPath('appData'), LEGACY_NAME)
    if (!moveIfFresh(legacy, app.getPath('userData'))) app.setPath('userData', legacy)
    for (const suffix of ['', '-wal', '-shm']) moveIfFresh(userFile(LEGACY_DB + suffix), userFile(DB_FILE + suffix))
  }
  const local = process.env.LOCALAPPDATA
  if (local) moveIfFresh(join(local, LEGACY_NAME), join(local, 'Gloop Voice'))
}

/** Models are gigabytes, so they live in the local (non-roaming) profile. */
export function modelsDir(): string {
  if (process.env.GLOOP_VOICE_MODELS_DIR) return process.env.GLOOP_VOICE_MODELS_DIR
  const local = process.env.LOCALAPPDATA
  if (!local) return userFile('models')
  const legacy = join(local, LEGACY_NAME, 'models')
  const current = join(local, 'Gloop Voice', 'models')
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

/** Files shipped beside the app rather than inside the archive (the native helper). */
export function resourcePath(...parts: string[]): string {
  return isDev ? join(app.getAppPath(), 'resources', ...parts) : join(process.resourcesPath, ...parts)
}
