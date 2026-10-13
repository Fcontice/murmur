import { app } from 'electron'
import { join } from 'node:path'

export const isDev = !app.isPackaged

export function userFile(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

/** Models are gigabytes, so they live in the local (non-roaming) profile. */
export function modelsDir(): string {
  if (process.env.MURMUR_MODELS_DIR) return process.env.MURMUR_MODELS_DIR
  const local = process.env.LOCALAPPDATA
  return local ? join(local, 'Murmur', 'models') : userFile('models')
}

/** Files shipped beside the app rather than inside the archive (the native helper). */
export function resourcePath(...parts: string[]): string {
  return isDev ? join(app.getAppPath(), 'resources', ...parts) : join(process.resourcesPath, ...parts)
}
