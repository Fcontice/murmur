import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { shortcutLabel } from '@shared/settings'
import type { AppContext, DictationMode, HistoryEntry, PillState, Settings, ShortcutAction, TextContext } from '@shared/types'
import { pcm16ToFloat32, peak, SAMPLE_RATE } from './asr/audio'
import type { AsrService } from './asr/service'
import type { Database } from './db'
import type { Helper, HelperContext } from './helper'
import { buildCommandRequest, restoreTags, tidyModelOutput } from './llm/prompts'
import type { LlmService } from './llm/service'
import { logger } from './log'
import { categorizeApp, isTerminal } from './text/apps'
import { basicCleanup, countWords } from './text/cleanup'
import { runPipeline } from './text/pipeline'

const log = logger('dictation')

/** A press shorter than this is a tap: a second tap locks hands-free, otherwise it was an accident. */
export const TAP_WINDOW_MS = 500
/** An unrelated key this soon after starting means the chord was really another shortcut (Ctrl+Win+Arrow). */
const OTHER_SHORTCUT_GRACE_MS = 1000
const MAX_RECORDING_MS = 20 * 60_000
const MIN_RECORDING_MS = 250
const SILENCE_PEAK = 0.003
const CAPTURE_STOP_TIMEOUT_MS = 1200
const NOTICE_MS = 4200
const CONTEXT_CHARS = 600
const MAX_COMMAND_SELECTION_CHARS = 12_000

export type SoundName = 'start' | 'stop' | 'lock' | 'error'

export interface CaptureBridge {
  start(sessionId: string): void
  stop(sessionId: string): void
  sound(name: SoundName): void
  copyToClipboard(text: string): void
}

interface Session {
  id: string
  mode: DictationMode
  startedAt: number
  capturingSince: number | null
  locked: boolean
  cancelled: boolean
  chunks: Int16Array[]
  context: Promise<HelperContext | null>
  tapTimer: NodeJS.Timeout | null
  maxTimer: NodeJS.Timeout | null
  onCaptureStopped: (() => void) | null
}

type Phase = 'idle' | 'starting' | 'listening' | 'processing'

export interface ControllerDeps {
  settings: () => Settings
  helper: Helper
  asr: AsrService
  llm: LlmService
  db: Database
  capture: CaptureBridge
  now?: () => number
}

export class DictationController extends EventEmitter<{ pill: [PillState]; history: [HistoryEntry] }> {
  private phase: Phase = 'idle'
  private session: Session | null = null
  private noticeTimer: NodeJS.Timeout | null = null
  private lastText = ''
  private readonly now: () => number
  /** Diagnostics: the next dictation transcribes this audio instead of what the microphone recorded. */
  audioOverride: Int16Array | null = null
  /** Diagnostics: only insert text while a process with this name is in the foreground. */
  requireForeground: string | null = null

  constructor(private readonly deps: ControllerDeps) {
    super()
    this.now = deps.now ?? Date.now
  }

  get pillState(): PillState {
    return this.currentPill
  }

  private currentPill: PillState = { phase: 'idle', mode: 'dictate', locked: false }

  private setPill(state: PillState): void {
    this.currentPill = state
    this.emit('pill', state)
  }

  private syncPill(): void {
    const session = this.session
    if (!session || this.phase === 'idle') return
    this.setPill({ phase: this.phase, mode: session.mode, locked: session.locked })
  }

  private notice(kind: 'info' | 'error', text: string): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.setPill({ phase: 'notice', mode: 'dictate', locked: false, notice: { kind, text } })
    if (kind === 'error') this.deps.capture.sound('error')
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      if (this.phase === 'idle') this.setPill({ phase: 'idle', mode: 'dictate', locked: false })
    }, NOTICE_MS)
  }

  // Input

  handleShortcut(action: ShortcutAction, phase: 'down' | 'up'): void {
    if (action === 'cancel') {
      if (phase === 'down') this.cancel()
      return
    }
    if (action === 'pasteLast') {
      if (phase === 'down') void this.pasteLast()
      return
    }

    const session = this.session
    const active = session !== null && (this.phase === 'starting' || this.phase === 'listening')

    if (phase === 'up') {
      if (active && (action === 'ptt' || action === 'command')) this.onHoldReleased(session)
      return
    }

    switch (action) {
      case 'ptt':
        if (this.phase === 'idle') this.start('dictate', false)
        else if (active && session.locked) void this.finish()
        else if (active && session.tapTimer) this.lock(session)
        break
      case 'handsFree':
        if (this.phase === 'idle') this.start('dictate', true)
        else if (active && !session.locked) this.lock(session)
        else if (active) void this.finish()
        break
      case 'command':
        if (this.phase === 'idle') this.start('command', false)
        else if (active && session.mode === 'dictate' && !session.locked && this.now() - session.startedAt < OTHER_SHORTCUT_GRACE_MS) {
          // The command chord contains the dictation chord, so dictation starts first and is upgraded here.
          session.mode = 'command'
          this.syncPill()
        }
        break
    }
  }

  /** A key that is not part of any shortcut was pressed while capturing. */
  handleOtherKey(): void {
    const session = this.session
    if (!session || session.locked || this.phase === 'processing') return
    if (this.now() - session.startedAt < OTHER_SHORTCUT_GRACE_MS) this.dismiss()
  }

  /** Buttons on the pill. */
  handlePillAction(action: 'finish' | 'cancel'): void {
    if (action === 'cancel') this.cancel()
    else if (this.session && (this.phase === 'starting' || this.phase === 'listening')) void this.finish()
  }

  private onHoldReleased(session: Session): void {
    if (session.locked || session.tapTimer) return
    if (this.now() - session.startedAt >= TAP_WINDOW_MS) {
      void this.finish()
      return
    }
    session.tapTimer = setTimeout(() => {
      session.tapTimer = null
      if (this.session !== session) return
      this.dismiss()
      const keys = shortcutLabel(this.deps.settings().shortcuts.ptt)
      this.notice('info', `Hold ${keys} while you speak, or double-tap to go hands-free.`)
    }, TAP_WINDOW_MS)
  }

  private lock(session: Session): void {
    if (session.tapTimer) clearTimeout(session.tapTimer)
    session.tapTimer = null
    session.locked = true
    this.deps.capture.sound('lock')
    this.syncPill()
  }

  // Lifecycle

  private start(mode: DictationMode, locked: boolean): void {
    const { asr, helper, capture } = this.deps
    if (asr.state !== 'ready') {
      this.notice(asr.state === 'loading' ? 'info' : 'error', asr.state === 'loading' ? 'The speech model is still loading. Try again in a moment.' : asr.detail || 'No speech model is set up. Open Murmur to finish setup.')
      return
    }
    if (mode === 'command' && !this.deps.llm.available) {
      this.notice('error', 'Command mode needs a language model. Turn on AI clean-up in Settings.')
      return
    }

    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = null

    const session: Session = {
      id: randomUUID(),
      mode,
      startedAt: this.now(),
      capturingSince: null,
      locked,
      cancelled: false,
      chunks: [],
      // Read the target before anything of ours can disturb focus.
      context: this.deps.settings().useAppContext || mode === 'command' ? helper.getContext(CONTEXT_CHARS) : Promise.resolve(null),
      tapTimer: null,
      maxTimer: null,
      onCaptureStopped: null,
    }
    session.maxTimer = setTimeout(() => this.session === session && void this.finish(), MAX_RECORDING_MS)
    this.session = session
    this.phase = 'starting'
    this.syncPill()
    helper.setCapturing(true)
    capture.start(session.id)
  }

  captureStarted(sessionId: string): void {
    const session = this.session
    if (!session || session.id !== sessionId || this.phase !== 'starting') return
    session.capturingSince = this.now()
    this.phase = 'listening'
    this.deps.capture.sound('start')
    this.syncPill()
  }

  captureChunk(sessionId: string, pcm: Int16Array): void {
    const session = this.session
    if (session && session.id === sessionId && this.phase !== 'idle') session.chunks.push(pcm)
  }

  captureStopped(sessionId: string): void {
    const session = this.session
    if (session && session.id === sessionId) session.onCaptureStopped?.()
  }

  captureFailed(sessionId: string, message: string): void {
    const session = this.session
    if (!session || session.id !== sessionId) return
    log.warn(`Capture failed: ${message}`)
    this.end(session)
    this.notice('error', message)
  }

  private clearTimers(session: Session): void {
    if (session.tapTimer) clearTimeout(session.tapTimer)
    if (session.maxTimer) clearTimeout(session.maxTimer)
    session.tapTimer = null
    session.maxTimer = null
  }

  private end(session: Session): void {
    this.clearTimers(session)
    if (this.session !== session) return
    this.session = null
    this.phase = 'idle'
    this.deps.helper.setCapturing(false)
    if (this.currentPill.phase !== 'notice') this.setPill({ phase: 'idle', mode: 'dictate', locked: false })
  }

  /** Stops silently and throws the audio away. */
  private dismiss(): void {
    const session = this.session
    if (!session) return
    session.cancelled = true
    if (this.phase !== 'processing') this.deps.capture.stop(session.id)
    this.end(session)
  }

  private cancel(): void {
    if (!this.session) return
    const wasProcessing = this.phase === 'processing'
    this.dismiss()
    this.notice('info', wasProcessing ? 'Cancelled. Nothing was inserted.' : 'Dictation cancelled.')
  }

  private async finish(): Promise<void> {
    const session = this.session
    if (!session || (this.phase !== 'starting' && this.phase !== 'listening')) return
    this.clearTimers(session)
    const heardAnything = this.phase === 'listening'
    this.phase = 'processing'
    this.syncPill()

    // The recorder flushes its last partial buffer before confirming.
    const stopped = new Promise<void>((resolve) => {
      session.onCaptureStopped = resolve
      setTimeout(resolve, CAPTURE_STOP_TIMEOUT_MS)
    })
    this.deps.capture.stop(session.id)
    await stopped
    if (heardAnything) this.deps.capture.sound('stop')

    try {
      await this.process(session)
    } catch (error) {
      log.error('Dictation failed', error)
      if (!session.cancelled) this.notice('error', error instanceof Error ? error.message : 'Something went wrong.')
    } finally {
      this.end(session)
    }
  }

  // Processing

  private describeApp(context: HelperContext | null): AppContext {
    const process = context?.app.process ?? ''
    const title = context?.app.title ?? ''
    return { name: context?.app.name ?? process, process, title, category: categorizeApp(process, title), isTerminal: isTerminal(process) }
  }

  private describeText(context: HelperContext | null): TextContext {
    const text = context?.text
    if (!text || !text.available || text.isPassword) return { available: false, before: '', after: '', selected: '', isPassword: Boolean(text?.isPassword) }
    return { available: true, before: text.before ?? '', after: text.after ?? '', selected: text.selected ?? '', isPassword: false }
  }

  private async process(session: Session): Promise<void> {
    const { asr, llm, db, helper } = this.deps
    const settings = this.deps.settings()
    const startedProcessing = this.now()

    const samples = pcm16ToFloat32(this.audioOverride ? [this.audioOverride] : session.chunks)
    this.audioOverride = null
    session.chunks = []
    const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000)
    const level = peak(samples)
    if (durationMs < MIN_RECORDING_MS || level < SILENCE_PEAK) {
      this.notice(level === 0 && durationMs >= MIN_RECORDING_MS ? 'error' : 'info', level === 0 && durationMs >= MIN_RECORDING_MS ? 'No sound came from the microphone. Check that it is not muted.' : 'No speech detected.')
      return
    }

    const helperContext = await session.context
    const app = this.describeApp(helperContext)
    const textContext = this.describeText(helperContext)

    const asrStarted = this.now()
    const raw = (await asr.transcribe(samples)).trim()
    const asrMs = this.now() - asrStarted
    if (session.cancelled) return
    if (!raw) {
      this.notice('info', "Didn't catch that. Try again a little closer to the microphone.")
      return
    }

    let text: string
    let pressEnter = false
    let usedLlm = false
    let llmMs = 0
    let dictionaryIds: string[] = []
    let snippetIds: string[] = []

    if (session.mode === 'command') {
      const llmStarted = this.now()
      const selection = textContext.selected || (await helper.copySelection())
      if (selection.length > MAX_COMMAND_SELECTION_CHARS) throw new Error('The selection is too long for command mode. Select a shorter passage.')
      const instruction = basicCleanup(raw, { voiceCommands: false, removeFillers: true })
      text = restoreTags(tidyModelOutput(await llm.complete(buildCommandRequest({ instruction, selection, screenText: '', appName: app.name }))))
      if (!text) throw new Error('The model returned nothing. Try rephrasing the instruction.')
      usedLlm = true
      llmMs = this.now() - llmStarted
    } else {
      const result = await runPipeline({
        raw,
        settings,
        app,
        textContext,
        dictionary: db.listDictionary(),
        snippets: db.listSnippets(),
        complete: llm.available ? llm.complete : undefined,
      })
      ;({ text, pressEnter, usedLlm, llmMs, dictionaryIds, snippetIds } = result)
    }
    if (session.cancelled) return

    let status: HistoryEntry['status'] = 'empty'
    let error: string | null = null
    if (text.trim() || pressEnter) {
      const pasted = await helper.paste(text, {
        method: settings.pasteMethod,
        restoreClipboard: settings.restoreClipboard,
        restoreDelayMs: settings.clipboardRestoreDelayMs,
        pressEnter,
        expectProcess: this.requireForeground ?? undefined,
      })
      if (pasted.ok) {
        status = 'pasted'
      } else if (pasted.error === 'focus_changed') {
        status = 'failed'
        error = pasted.error
        this.notice('error', 'The target window lost focus, so nothing was inserted.')
      } else {
        // Whatever went wrong, the words are not lost.
        this.deps.capture.copyToClipboard(text.trim())
        status = 'copied'
        error = pasted.error ?? 'paste_failed'
        this.notice('error', pasted.error === 'target_elevated'
          ? 'This window runs as administrator, so Murmur cannot type into it. The text is on your clipboard.'
          : 'Could not insert the text. It is on your clipboard: press Ctrl+V.')
      }
      this.lastText = text.trim()
    }

    const entry = db.addHistory(
      {
        createdAt: session.startedAt,
        mode: session.mode,
        rawText: raw,
        finalText: text.trim(),
        status,
        error,
        appName: app.name,
        appProcess: app.process,
        durationMs,
        wordCount: countWords(text),
        asrMs,
        llmMs,
        totalMs: this.now() - startedProcessing,
        usedLlm,
      },
      settings.saveHistory,
    )
    db.recordUses(dictionaryIds, snippetIds)
    this.emit('history', entry)
    log.info(`Dictation done: ${durationMs} ms audio, asr ${asrMs} ms, llm ${llmMs} ms, ${entry.wordCount} words, ${status}`)
  }

  private async pasteLast(): Promise<void> {
    if (this.phase !== 'idle') return
    if (!this.lastText) {
      this.notice('info', 'Nothing to paste yet.')
      return
    }
    const settings = this.deps.settings()
    const result = await this.deps.helper.paste(this.lastText, {
      method: settings.pasteMethod,
      restoreClipboard: settings.restoreClipboard,
      restoreDelayMs: settings.clipboardRestoreDelayMs,
      pressEnter: false,
    })
    if (!result.ok) {
      this.deps.capture.copyToClipboard(this.lastText)
      this.notice('error', 'Could not insert the text. It is on your clipboard: press Ctrl+V.')
    }
  }

  get busy(): boolean {
    return this.phase !== 'idle'
  }
}
