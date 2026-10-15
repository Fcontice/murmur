import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { existsSync } from 'node:fs'
import type { AppInfo } from '@shared/api'
import { DEFAULT_SHORTCUTS, normaliseSettingsPatch, sameKeys, shortcutLabel, validateShortcut } from '@shared/settings'
import type { EngineStatus, Settings, ShortcutAction } from '@shared/types'
import { AsrService } from './asr/service'
import { DictationController } from './controller'
import { Database } from './db'
import { Helper } from './helper'
import { LlmService, reapStaleServer } from './llm/service'
import { logger } from './log'
import { ModelManager } from './models'
import { dbFile, migrateLegacyData, resourcePath } from './paths'
import { SettingsStore } from './settings-store'
import { createHubWindow, createPillWindow, positionPill } from './windows'

const log = logger('app')
const startHidden = process.argv.includes('--hidden')

// A separate profile for development and automated checks, so they never touch real data.
if (process.env.GLOOP_VOICE_USER_DATA) app.setPath('userData', process.env.GLOOP_VOICE_USER_DATA)
migrateLegacyData()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setAppUserModelId('com.fcontice.gloopvoice')
  void app.whenReady().then(main)
}

async function main(): Promise<void> {
  // The self-test writes history, snippets and settings, so it never runs against the real profile.
  if (process.env.GLOOP_VOICE_SELFTEST && !app.isPackaged && !process.env.GLOOP_VOICE_USER_DATA) {
    log.error('The self-test needs GLOOP_VOICE_USER_DATA set to a scratch folder; quitting')
    app.quit()
    return
  }
  const settings = new SettingsStore()
  const db = new Database(dbFile())
  const models = new ModelManager()
  const helper = new Helper()
  const asr = new AsrService(models)
  const llm = new LlmService(models)

  const iconPath = resourcePath('icon.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()

  let quitting = false
  let hub: BrowserWindow | null = null
  const pill = createPillWindow()
  let pillReady = false

  const toHub = (channel: string, payload: unknown) => {
    if (hub && !hub.isDestroyed()) hub.webContents.send(channel, payload)
  }
  const toPill = (channel: string, payload?: unknown) => {
    if (!pill.isDestroyed()) pill.webContents.send(channel, payload)
  }

  function showHub(): BrowserWindow {
    if (!hub || hub.isDestroyed()) {
      const created = createHubWindow(icon)
      hub = created
      created.once('ready-to-show', () => created.show())
      created.on('close', (event) => {
        // Closing the window keeps dictation running from the tray.
        if (quitting) return
        event.preventDefault()
        created.hide()
      })
      return created
    }
    if (hub.isMinimized()) hub.restore()
    hub.show()
    hub.focus()
    return hub
  }

  // Microphone access is granted to our own pages and nothing else.
  const isOwnPage = (url: string) => url.startsWith('file://') || (!app.isPackaged && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0'))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'media' && isOwnPage(contents.getURL())))
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'media' && isOwnPage(contents?.getURL() ?? ''))

  const controller = new DictationController({
    settings: () => settings.get(),
    helper,
    asr,
    llm,
    db,
    capture: {
      start: (sessionId) => {
        positionPill(pill)
        toPill('capture:start', sessionId)
      },
      stop: (sessionId) => toPill('capture:stop', sessionId),
      sound: (name) => settings.get().sounds && toPill('pill:sound', name),
      copyToClipboard: (text) => clipboard.writeText(text),
    },
    openUrl: async (url) => {
      // Only web pages: a spoken or saved target must never launch a file or another protocol handler.
      const { protocol } = new URL(url)
      if (protocol !== 'https:' && protocol !== 'http:') throw new Error('Only web addresses can be opened.')
      await shell.openExternal(url)
    },
  })
  helper.on('status', (state) => state === 'ready' && controller.warmApps())

  // Engine status

  const status = (): EngineStatus => ({ helper: helper.status, asr: asr.state, llm: llm.state, asrDetail: asr.detail, llmDetail: llm.detail })
  const publishStatus = () => {
    toHub('status:changed', status())
    refreshTray()
  }
  helper.on('status', publishStatus)
  asr.on('status', publishStatus)
  llm.on('status', publishStatus)

  // Pill

  const pushPillConfig = () => {
    const current = settings.get()
    toPill('pill:config', {
      microphoneId: current.microphoneId,
      keepMicWarm: current.keepMicWarm,
      sounds: current.sounds,
      showPillWhenIdle: current.showPillWhenIdle,
      pttLabel: shortcutLabel(current.shortcuts.ptt),
    })
  }
  controller.on('pill', (state) => {
    toPill('pill:state', state)
    if (state.phase !== 'idle' && pillReady && !pill.isVisible()) pill.showInactive()
  })
  controller.on('history', (entry) => toHub('history:added', entry))

  ipcMain.on('pill:ready', () => {
    pillReady = true
    pushPillConfig()
    toPill('pill:state', controller.pillState)
    pill.showInactive()
  })
  ipcMain.on('pill:interactive', (_event, interactive: boolean) => pill.setIgnoreMouseEvents(!interactive, { forward: true }))
  ipcMain.on('pill:action', (_event, action: 'finish' | 'cancel' | 'openHub') => {
    if (action === 'openHub') showHub()
    else controller.handlePillAction(action)
  })
  ipcMain.on('capture:started', (_event, sessionId: string) => controller.captureStarted(sessionId))
  ipcMain.on('capture:chunk', (_event, sessionId: string, pcm: ArrayBuffer) => controller.captureChunk(sessionId, new Int16Array(pcm)))
  ipcMain.on('capture:stopped', (_event, sessionId: string) => controller.captureStopped(sessionId))
  ipcMain.on('capture:failed', (_event, sessionId: string, message: string) => controller.captureFailed(sessionId, message))

  // Helper

  let shortcutRecorder: ((keys: number[] | null) => void) | null = null
  helper.on('shortcut', (action, phase) => controller.handleShortcut(action, phase))
  helper.on('otherKey', () => controller.handleOtherKey())
  helper.on('recorded', (keys) => {
    shortcutRecorder?.(keys)
    shortcutRecorder = null
  })

  // Settings

  function applySettings(current: Settings, previous?: Settings): void {
    helper.setShortcuts(current.shortcuts)
    asr.configure(current)
    llm.configure(current)
    pushPillConfig()
    if (!previous || previous.launchAtLogin !== current.launchAtLogin) {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: current.launchAtLogin, args: ['--hidden'] })
    }
    if (!previous || previous.historyRetentionDays !== current.historyRetentionDays) db.pruneHistory(current.historyRetentionDays)
  }
  settings.on('change', (current, previous) => {
    applySettings(current, previous)
    toHub('settings:changed', current)
    refreshTray()
  })
  models.on('change', (list) => toHub('models:changed', list))
  models.on('installed', (id) => {
    asr.configure(settings.get())
    if (models.definition(id)?.kind === 'runtime') llm.restart()
    else llm.configure(settings.get())
  })

  let nvidiaGpu = false
  void app.getGPUInfo('basic').then((info) => {
    const devices = (info as { gpuDevice?: Array<{ vendorId: number }> }).gpuDevice ?? []
    nvidiaGpu = devices.some((device) => device.vendorId === 0x10de)
  }, () => undefined)

  function updateSettings(patch: Partial<Settings>): Settings {
    if (patch.shortcuts) {
      const current = settings.get().shortcuts
      for (const [action, keys] of Object.entries(patch.shortcuts) as Array<[ShortcutAction, number[]]>) {
        const problem = validateShortcut(action, keys)
        if (problem) throw new Error(problem)
        const clash = (Object.entries({ ...current, ...patch.shortcuts }) as Array<[ShortcutAction, number[]]>).find(
          ([other, otherKeys]) => other !== action && sameKeys(otherKeys, keys),
        )
        if (clash) throw new Error(`${shortcutLabel(keys)} is already used by another shortcut.`)
      }
    }
    return settings.update(normaliseSettingsPatch(patch))
  }

  // IPC for the main window

  const handle = (channel: string, handler: (...args: never[]) => unknown) =>
    ipcMain.handle(channel, (_event, ...args) => (handler as (...a: unknown[]) => unknown)(...args))

  // The new stores trim and measure their input, so a malformed request is turned away before it reaches them.
  const checkedId = (id: unknown): string => {
    if (typeof id !== 'string') throw new Error('Invalid request.')
    return id
  }
  const checked = <T extends { id?: string }>(input: T, ...fields: Array<keyof T>): T => {
    if (!input || typeof input !== 'object') throw new Error('Invalid request.')
    if (input.id !== undefined) checkedId(input.id)
    if (fields.some((field) => typeof input[field] !== 'string')) throw new Error('Invalid request.')
    return input
  }

  handle('settings:get', () => settings.get())
  handle('settings:update', (patch: Partial<Settings>) => updateSettings(patch))
  handle('status:get', () => status())
  handle('models:list', () => models.list())
  handle('models:download', (id: string) => void models.download(id))
  handle('models:cancel', (id: string) => models.cancel(id))
  handle('models:remove', async (id: string) => {
    const kind = models.definition(id)?.kind
    // The runtime's files are in use while the model is loaded from it.
    if (kind === 'runtime') llm.dispose()
    await models.remove(id)
    asr.configure(settings.get())
    if (kind === 'runtime') llm.restart()
    else llm.configure(settings.get())
  })
  handle('llm:test', () => llm.test())
  handle('history:list', (query: string, limit: number, offset: number) => db.listHistory(query, Math.min(limit, 200), offset))
  handle('history:delete', (id: string) => db.deleteHistory(id))
  handle('history:clear', () => db.clearHistory())
  handle('stats:get', () => db.stats())
  handle('dictionary:list', () => db.listDictionary())
  handle('dictionary:save', (entry: { id?: string; phrase: string; heardAs: string[] }) => db.saveDictionaryEntry(entry))
  handle('dictionary:delete', (id: string) => db.deleteDictionaryEntry(id))
  handle('snippets:list', () => db.listSnippets())
  handle('snippets:save', (snippet: { id?: string; trigger: string; expansion: string }) => db.saveSnippet(snippet))
  handle('snippets:delete', (id: string) => db.deleteSnippet(id))
  handle('commands:list', () => db.listCommands())
  handle('commands:save', (command: { id?: string; name: string; prompt: string }) => db.saveCommand(checked(command, 'name', 'prompt')))
  handle('commands:delete', (id: string) => db.deleteCommand(checkedId(id)))
  handle('sites:list', () => db.listSites())
  handle('sites:save', (site: { id?: string; name: string; url: string }) => db.saveSite(checked(site, 'name', 'url')))
  handle('sites:delete', (id: string) => db.deleteSite(checkedId(id)))
  handle('shortcut:record', () => {
    shortcutRecorder?.(null)
    helper.recordShortcut(true)
    return new Promise<number[] | null>((resolve) => {
      shortcutRecorder = resolve
    })
  })
  handle('shortcut:stop', () => {
    helper.recordShortcut(false)
    shortcutRecorder?.(null)
    shortcutRecorder = null
  })
  handle('shortcut:reset', (action: ShortcutAction) => updateSettings({ shortcuts: { ...settings.get().shortcuts, [action]: DEFAULT_SHORTCUTS[action] } }))
  handle('app:copy', (text: string) => clipboard.writeText(text))
  handle('app:openData', () => shell.openPath(app.getPath('userData')))
  handle('app:info', (): AppInfo => ({ version: app.getVersion(), dataDir: app.getPath('userData'), nvidiaGpu }))

  // Tray

  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.on('click', showHub)
  function refreshTray(): void {
    const current = settings.get()
    const ready = helper.status === 'ready' && asr.state === 'ready'
    tray.setToolTip(ready ? `Gloop Voice · hold ${shortcutLabel(current.shortcuts.ptt)} to dictate` : 'Gloop Voice · setting up')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Gloop Voice', click: showHub },
        { type: 'separator' },
        { label: `Dictate: ${shortcutLabel(current.shortcuts.ptt)}`, enabled: false },
        { label: `Hands-free: ${shortcutLabel(current.shortcuts.handsFree)}`, enabled: false },
        { type: 'separator' },
        { label: 'Sounds', type: 'checkbox', checked: current.sounds, click: (item) => void settings.update({ sounds: item.checked }) },
        { type: 'separator' },
        { label: 'Quit Gloop Voice', click: () => app.quit() },
      ]),
    )
  }

  // Lifecycle

  app.on('second-instance', showHub)
  app.on('window-all-closed', () => undefined)
  app.on('before-quit', () => {
    quitting = true
    helper.stop()
    asr.dispose()
    llm.dispose()
    try {
      db.close()
    } catch {
      // already closed
    }
  })
  process.on('uncaughtException', (error) => log.error('Uncaught exception', error))
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason))

  helper.start()
  await reapStaleServer()
  applySettings(settings.get())
  refreshTray()
  log.info(`Gloop Voice ${app.getVersion()} started`)

  if (process.env.GLOOP_VOICE_SELFTEST && !app.isPackaged) {
    const outDir = process.env.GLOOP_VOICE_SELFTEST
    void import('./selftest').then(({ runSelfTest }) => runSelfTest({ outDir, controller, helper, asr, llm, db, settings, pill, showHub }))
  } else if (!startHidden || !settings.get().onboarded) {
    showHub()
  }
}
