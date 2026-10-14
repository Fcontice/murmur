import type {
  DictionaryEntry, EngineStatus, HistoryEntry, ModelStatus, PillState, SavedCommand, Settings, ShortcutAction, Site, Snippet, Stats,
} from './types'

export type Unsubscribe = () => void

export interface AppInfo {
  version: string
  dataDir: string
  nvidiaGpu: boolean
}

export interface TestResult {
  ok: boolean
  message: string
}

/** Exposed to the main window as `window.murmur`. */
export interface HubApi {
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  onSettings(listener: (settings: Settings) => void): Unsubscribe

  getStatus(): Promise<EngineStatus>
  onStatus(listener: (status: EngineStatus) => void): Unsubscribe

  listModels(): Promise<ModelStatus[]>
  downloadModel(id: string): Promise<void>
  cancelModel(id: string): Promise<void>
  removeModel(id: string): Promise<void>
  onModels(listener: (models: ModelStatus[]) => void): Unsubscribe
  testLlm(): Promise<TestResult>

  listHistory(query: string, limit: number, offset: number): Promise<HistoryEntry[]>
  deleteHistory(id: string): Promise<void>
  clearHistory(): Promise<void>
  onHistory(listener: (entry: HistoryEntry) => void): Unsubscribe
  getStats(): Promise<Stats>

  listDictionary(): Promise<DictionaryEntry[]>
  saveDictionaryEntry(entry: { id?: string; phrase: string; heardAs: string[] }): Promise<DictionaryEntry>
  deleteDictionaryEntry(id: string): Promise<void>

  listSnippets(): Promise<Snippet[]>
  saveSnippet(snippet: { id?: string; trigger: string; expansion: string }): Promise<Snippet>
  deleteSnippet(id: string): Promise<void>

  listCommands(): Promise<SavedCommand[]>
  saveCommand(command: { id?: string; name: string; prompt: string }): Promise<SavedCommand>
  deleteCommand(id: string): Promise<void>

  listSites(): Promise<Site[]>
  saveSite(site: { id?: string; name: string; url: string }): Promise<Site>
  deleteSite(id: string): Promise<void>

  /** Resolves with the chord the user pressed, or null if recording was stopped. */
  recordShortcut(): Promise<number[] | null>
  stopRecordingShortcut(): Promise<void>
  resetShortcut(action: ShortcutAction): Promise<Settings>

  copyText(text: string): Promise<void>
  openDataFolder(): Promise<void>
  getAppInfo(): Promise<AppInfo>
}

export interface CaptureConfig {
  microphoneId: string | null
  keepMicWarm: boolean
  sounds: boolean
  showPillWhenIdle: boolean
  pttLabel: string
}

/** Exposed to the floating pill window as `window.murmurPill`. */
export interface PillApi {
  onState(listener: (state: PillState) => void): Unsubscribe
  onConfig(listener: (config: CaptureConfig) => void): Unsubscribe
  onCaptureStart(listener: (sessionId: string) => void): Unsubscribe
  onCaptureStop(listener: (sessionId: string) => void): Unsubscribe
  onSound(listener: (name: 'start' | 'stop' | 'lock' | 'error') => void): Unsubscribe
  ready(): void
  captureStarted(sessionId: string): void
  captureChunk(sessionId: string, pcm: ArrayBuffer): void
  captureStopped(sessionId: string): void
  captureFailed(sessionId: string, message: string): void
  action(action: 'finish' | 'cancel' | 'openHub'): void
  /** The window ignores the mouse except while the pointer is over the pill itself. */
  setInteractive(interactive: boolean): void
}
