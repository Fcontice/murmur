export type ShortcutAction = 'ptt' | 'handsFree' | 'command' | 'pasteLast' | 'cancel'

export type AppCategory = 'personal' | 'work' | 'email' | 'developer' | 'chatbot' | 'other'
export type StyleCategory = 'personal' | 'work' | 'email' | 'other'
export type WritingStyle = 'formal' | 'casual' | 'veryCasual'
export type EditingStrength = 'verbatim' | 'light' | 'medium' | 'heavy'

export type AsrProvider = 'local' | 'remote'
export type LlmProvider = 'local' | 'remote' | 'off'

export interface Settings {
  onboarded: boolean
  shortcuts: Record<ShortcutAction, number[]>
  microphoneId: string | null
  keepMicWarm: boolean
  sounds: boolean
  showPillWhenIdle: boolean
  launchAtLogin: boolean
  theme: 'dark' | 'light' | 'system'

  asrProvider: AsrProvider
  asrModel: string
  asrRemote: { baseUrl: string; apiKey: string; model: string }
  language: string

  llmProvider: LlmProvider
  llmModel: string
  llmRemote: { baseUrl: string; apiKey: string; model: string }

  editingStrength: EditingStrength
  styles: Record<StyleCategory, WritingStyle>
  smartSpacing: boolean
  voiceCommands: boolean
  useAppContext: boolean
  /** Web search URL with {query} where the encoded search terms go. */
  searchUrl: string

  pasteMethod: 'clipboard' | 'type'
  restoreClipboard: boolean
  clipboardRestoreDelayMs: number

  saveHistory: boolean
  historyRetentionDays: number
}

export type DictationMode = 'dictate' | 'command'

export type PillPhase = 'idle' | 'starting' | 'listening' | 'processing' | 'notice'

export interface PillState {
  phase: PillPhase
  mode: DictationMode
  locked: boolean
  notice?: { kind: 'info' | 'error'; text: string }
}

export interface AppContext {
  name: string
  process: string
  title: string
  category: AppCategory
  isTerminal: boolean
}

export interface TextContext {
  available: boolean
  before: string
  after: string
  selected: string
  isPassword: boolean
}

export type HistoryStatus = 'pasted' | 'copied' | 'failed' | 'empty' | 'action'

export interface HistoryEntry {
  id: string
  createdAt: number
  mode: DictationMode
  rawText: string
  finalText: string
  status: HistoryStatus
  error: string | null
  appName: string
  appProcess: string
  durationMs: number
  wordCount: number
  asrMs: number
  llmMs: number
  totalMs: number
  usedLlm: boolean
}

export interface DictionaryEntry {
  id: string
  phrase: string
  /** Ways the recogniser tends to mishear the phrase. Each is replaced with the phrase. */
  heardAs: string[]
  createdAt: number
  uses: number
}

export interface Snippet {
  id: string
  trigger: string
  expansion: string
  createdAt: number
  uses: number
}

export interface SavedCommand {
  id: string
  name: string
  prompt: string
  createdAt: number
  uses: number
}

export interface Site {
  id: string
  name: string
  url: string
  createdAt: number
}

/** An entry in the Windows Apps folder. `id` is its parsing name under shell:AppsFolder. */
export interface InstalledApp {
  name: string
  id: string
}

export interface Stats {
  totalWords: number
  totalDictations: number
  totalSpeechMs: number
  wordsPerMinute: number
  streakDays: number
  wordsToday: number
}

export type ModelKind = 'asr' | 'llm' | 'runtime'

export interface ModelInfo {
  id: string
  kind: ModelKind
  name: string
  description: string
  sizeBytes: number
  languages: string
  recommended?: boolean
}

export interface ModelStatus extends ModelInfo {
  installed: boolean
  downloading: boolean
  /** 0..1 while downloading */
  progress: number
  error: string | null
}

export interface EngineStatus {
  helper: 'starting' | 'ready' | 'failed'
  asr: 'unavailable' | 'loading' | 'ready' | 'failed'
  llm: 'off' | 'unavailable' | 'loading' | 'ready' | 'failed'
  asrDetail: string
  llmDetail: string
}

export interface AudioChunkMessage {
  sessionId: string
  /** 16 kHz mono signed 16-bit PCM */
  pcm: ArrayBuffer
}

export interface MicDevice {
  deviceId: string
  label: string
}
