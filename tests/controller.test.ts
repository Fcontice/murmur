import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { HistoryEntry, PillState, Settings } from '@shared/types'
import { DictationController, TAP_WINDOW_MS, type ControllerDeps } from '../src/main/controller'
import { Database } from '../src/main/db'

vi.mock('../src/main/log', () => ({ logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }))

const speech = () => new Int16Array(16_000).fill(6000) // one second, clearly not silence

function setup(overrides: { settings?: Partial<Settings>; asrState?: string; llmAvailable?: boolean; transcript?: string; pasteOk?: boolean; selected?: string } = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides.settings }
  const db = new Database(':memory:')
  const capture = { start: vi.fn(), stop: vi.fn(), sound: vi.fn(), copyToClipboard: vi.fn() }
  const helper = {
    setCapturing: vi.fn(),
    getContext: vi.fn(async () => ({
      app: { name: 'Notepad', process: 'notepad', title: 'Untitled' },
      text: { available: true, before: '', after: '', selected: overrides.selected ?? '' },
    })),
    copySelection: vi.fn(async () => ''),
    paste: vi.fn(async () => (overrides.pasteOk === false ? { ok: false, error: 'input_blocked' } : { ok: true })),
  }
  const asr = { state: overrides.asrState ?? 'ready', detail: '', transcribe: vi.fn(async () => overrides.transcript ?? 'hello world') }
  const llm = { available: overrides.llmAvailable ?? false, complete: vi.fn(async (_request: { user: string }) => 'Rewritten text.') }
  const controller = new DictationController({ settings: () => settings, helper, asr, llm, db, capture } as unknown as ControllerDeps)

  const pills: PillState[] = []
  const history: HistoryEntry[] = []
  controller.on('pill', (state) => pills.push(state))
  controller.on('history', (entry) => history.push(entry))

  const sessionId = () => capture.start.mock.calls.at(-1)?.[0] as string
  /** Simulates the recorder: confirm the start, deliver audio. */
  const record = () => {
    controller.captureStarted(sessionId())
    controller.captureChunk(sessionId(), speech())
  }
  /** Simulates the recorder confirming the stop, then lets processing run to the end. */
  const settle = async () => {
    controller.captureStopped(sessionId())
    await vi.runAllTimersAsync()
  }
  return { controller, capture, helper, asr, llm, db, pills, history, record, settle, sessionId }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('push to talk', () => {
  it('records while held and inserts the text on release', async () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down')
    expect(t.capture.start).toHaveBeenCalledOnce()
    expect(t.helper.setCapturing).toHaveBeenLastCalledWith(true)
    t.record()
    expect(t.pills.at(-1)).toMatchObject({ phase: 'listening', locked: false })

    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('ptt', 'up')
    expect(t.capture.stop).toHaveBeenCalledWith(t.sessionId())
    expect(t.pills.at(-1)?.phase).toBe('processing')
    await t.settle()

    expect(t.asr.transcribe).toHaveBeenCalledOnce()
    expect(t.helper.paste).toHaveBeenCalledWith('Hello world ', expect.objectContaining({ method: 'clipboard', pressEnter: false }))
    expect(t.history).toHaveLength(1)
    expect(t.history[0]).toMatchObject({ status: 'pasted', rawText: 'hello world', finalText: 'Hello world', wordCount: 2, appName: 'Notepad' })
    expect(t.pills.at(-1)?.phase).toBe('idle')
    expect(t.helper.setCapturing).toHaveBeenLastCalledWith(false)
    expect(t.db.listHistory('', 10, 0)).toHaveLength(1)
  })

  it('treats a quick tap as an accident and explains what to do', async () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down')
    t.record()
    vi.advanceTimersByTime(120)
    t.controller.handleShortcut('ptt', 'up')
    expect(t.capture.stop).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TAP_WINDOW_MS)
    expect(t.capture.stop).toHaveBeenCalledOnce()
    expect(t.pills.at(-1)).toMatchObject({ phase: 'notice', notice: { kind: 'info' } })
    expect(t.pills.at(-1)?.notice?.text).toContain('Ctrl + Win')
    await vi.runAllTimersAsync()
    expect(t.asr.transcribe).not.toHaveBeenCalled()
    expect(t.helper.paste).not.toHaveBeenCalled()
    expect(t.pills.at(-1)?.phase).toBe('idle')
  })

  it('locks into hands-free on a double tap and stops on the next press', async () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down')
    t.record()
    vi.advanceTimersByTime(100)
    t.controller.handleShortcut('ptt', 'up')
    vi.advanceTimersByTime(150)
    t.controller.handleShortcut('ptt', 'down')
    expect(t.pills.at(-1)).toMatchObject({ phase: 'listening', locked: true })
    expect(t.capture.sound).toHaveBeenCalledWith('lock')

    t.controller.handleShortcut('ptt', 'up')
    vi.advanceTimersByTime(5000)
    expect(t.capture.stop).not.toHaveBeenCalled()

    t.controller.handleShortcut('ptt', 'down')
    expect(t.capture.stop).toHaveBeenCalledOnce()
    await t.settle()
    expect(t.helper.paste).toHaveBeenCalledOnce()
  })

  it('abandons the recording when the chord turns out to be another shortcut', async () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down')
    t.record()
    vi.advanceTimersByTime(300)
    t.controller.handleOtherKey()
    expect(t.capture.stop).toHaveBeenCalledOnce()
    expect(t.pills.at(-1)?.phase).toBe('idle')
    await vi.runAllTimersAsync()
    expect(t.helper.paste).not.toHaveBeenCalled()
  })

  it('keeps recording when another key is pressed later on', () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down')
    t.record()
    vi.advanceTimersByTime(1500)
    t.controller.handleOtherKey()
    expect(t.capture.stop).not.toHaveBeenCalled()
  })
})

describe('hands-free shortcut', () => {
  it('upgrades a held dictation to locked and ignores the release', async () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down') // the hands-free chord contains the dictation chord
    t.controller.handleShortcut('handsFree', 'down')
    t.record()
    expect(t.pills.at(-1)).toMatchObject({ locked: true })
    t.controller.handleShortcut('handsFree', 'up')
    t.controller.handleShortcut('ptt', 'up')
    vi.advanceTimersByTime(3000)
    expect(t.capture.stop).not.toHaveBeenCalled()

    t.controller.handleShortcut('ptt', 'down')
    t.controller.handleShortcut('handsFree', 'down') // arrives while already processing
    await t.settle()
    expect(t.helper.paste).toHaveBeenCalledOnce()
    expect(t.capture.start).toHaveBeenCalledOnce()
  })
})

describe('cancel', () => {
  it('discards the recording', async () => {
    const t = setup()
    t.controller.handleShortcut('handsFree', 'down')
    t.record()
    t.controller.handleShortcut('cancel', 'down')
    expect(t.capture.stop).toHaveBeenCalledOnce()
    expect(t.pills.at(-1)).toMatchObject({ phase: 'notice' })
    await vi.runAllTimersAsync()
    expect(t.asr.transcribe).not.toHaveBeenCalled()
    expect(t.history).toHaveLength(0)
  })

  it('stops text being inserted when pressed during processing', async () => {
    const t = setup()
    let release: (text: string) => void = () => undefined
    t.asr.transcribe.mockImplementation(() => new Promise<string>((resolve) => (release = resolve)))
    t.controller.handleShortcut('handsFree', 'down')
    t.record()
    t.controller.handleShortcut('handsFree', 'down')
    t.controller.captureStopped(t.sessionId())
    await vi.advanceTimersByTimeAsync(10)
    t.controller.handleShortcut('cancel', 'down')
    release('too late')
    await vi.runAllTimersAsync()
    expect(t.helper.paste).not.toHaveBeenCalled()
  })
})

describe('command mode', () => {
  it('switches from dictation when the longer chord completes, then rewrites the selection', async () => {
    const t = setup({ llmAvailable: true, transcript: 'make this shorter', selected: 'A rather long sentence.' })
    t.controller.handleShortcut('ptt', 'down')
    vi.advanceTimersByTime(80)
    t.controller.handleShortcut('command', 'down')
    t.record()
    expect(t.pills.at(-1)).toMatchObject({ mode: 'command' })
    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('command', 'up')
    t.controller.handleShortcut('ptt', 'up')
    await t.settle()

    expect(t.llm.complete).toHaveBeenCalledOnce()
    const request = t.llm.complete.mock.calls[0]![0]
    expect(request.user).toContain('A rather long sentence.')
    expect(request.user).toContain('Make this shorter')
    expect(t.helper.paste).toHaveBeenCalledWith('Rewritten text.', expect.anything())
    expect(t.history[0]).toMatchObject({ mode: 'command', usedLlm: true })
  })

  it('refuses to start without a language model', () => {
    const t = setup({ llmAvailable: false })
    t.controller.handleShortcut('command', 'down')
    expect(t.capture.start).not.toHaveBeenCalled()
    expect(t.pills.at(-1)).toMatchObject({ phase: 'notice', notice: { kind: 'error' } })
  })
})

describe('failure handling', () => {
  it('copies the text when it cannot be inserted', async () => {
    const t = setup({ pasteOk: false })
    t.controller.handleShortcut('handsFree', 'down')
    t.record()
    t.controller.handleShortcut('handsFree', 'down')
    await vi.advanceTimersByTimeAsync(50)
    t.controller.captureStopped(t.sessionId())
    await vi.advanceTimersByTimeAsync(50)
    expect(t.capture.copyToClipboard).toHaveBeenCalledWith('Hello world')
    expect(t.history[0]).toMatchObject({ status: 'copied', error: 'input_blocked' })
    expect(t.pills.at(-1)).toMatchObject({ phase: 'notice', notice: { kind: 'error' } })
  })

  it('does not start while the speech model is unavailable', () => {
    const t = setup({ asrState: 'unavailable' })
    t.controller.handleShortcut('ptt', 'down')
    expect(t.capture.start).not.toHaveBeenCalled()
    expect(t.pills.at(-1)).toMatchObject({ phase: 'notice', notice: { kind: 'error' } })
  })

  it('reports silence instead of transcribing it', async () => {
    const t = setup()
    t.controller.handleShortcut('handsFree', 'down')
    t.controller.captureStarted(t.sessionId())
    t.controller.captureChunk(t.sessionId(), new Int16Array(16_000).fill(3))
    t.controller.handleShortcut('handsFree', 'down')
    t.controller.captureStopped(t.sessionId())
    await vi.advanceTimersByTimeAsync(50)
    expect(t.asr.transcribe).not.toHaveBeenCalled()
    expect(t.pills.at(-1)?.notice?.text).toBe('No speech detected.')
  })

  it('reports a microphone failure', () => {
    const t = setup()
    t.controller.handleShortcut('ptt', 'down')
    t.controller.captureFailed(t.sessionId(), 'No microphone was found.')
    expect(t.pills.at(-1)).toMatchObject({ phase: 'notice', notice: { kind: 'error', text: 'No microphone was found.' } })
    expect(t.helper.setCapturing).toHaveBeenLastCalledWith(false)
  })

  it('does not save history when that is turned off, but still counts words', async () => {
    const t = setup({ settings: { saveHistory: false } })
    t.controller.handleShortcut('handsFree', 'down')
    t.record()
    t.controller.handleShortcut('handsFree', 'down')
    await t.settle()
    expect(t.db.listHistory('', 10, 0)).toHaveLength(0)
    expect(t.db.stats().totalWords).toBe(2)
  })
})

describe('paste last', () => {
  it('re-inserts the previous result', async () => {
    const t = setup()
    t.controller.handleShortcut('handsFree', 'down')
    t.record()
    t.controller.handleShortcut('handsFree', 'down')
    await t.settle()
    t.controller.handleShortcut('pasteLast', 'down')
    await vi.runAllTimersAsync()
    expect(t.helper.paste).toHaveBeenLastCalledWith('Hello world', expect.objectContaining({ pressEnter: false }))
  })
})
