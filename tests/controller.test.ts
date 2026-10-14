import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { HistoryEntry, PillState, Settings } from '@shared/types'
import { DictationController, TAP_WINDOW_MS, type ControllerDeps } from '../src/main/controller'
import { Database } from '../src/main/db'
import { TruncatedError } from '../src/main/llm/errors'

const logged = vi.hoisted(() => [] as string[])
vi.mock('../src/main/log', () => {
  const record = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  return { logger: () => ({ info: vi.fn(record), warn: vi.fn(record), error: vi.fn(record) }) }
})

const speech = () => new Int16Array(16_000).fill(6000) // one second, clearly not silence

function setup(
  overrides: {
    settings?: Partial<Settings>
    asrState?: string
    llmAvailable?: boolean
    transcript?: string
    pasteOk?: boolean
    selected?: string
    apps?: Array<{ name: string; id: string }>
    launchOk?: boolean
    windowText?: string
    openFails?: boolean
  } = {},
) {
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
    listApps: vi.fn(
      async (): Promise<Array<{ name: string; id: string }> | null> =>
        overrides.apps ?? [{ name: 'Spotify', id: 'SpotifyAB.SpotifyMusic!Spotify' }, { name: 'Character Map', id: 'charmap' }],
    ),
    launchApp: vi.fn(async () => overrides.launchOk ?? true),
    getWindowText: vi.fn(async () => ({ text: overrides.windowText ?? '', elapsedMs: 5, source: 'focused_document' })),
  }
  const asr = { state: overrides.asrState ?? 'ready', detail: '', transcribe: vi.fn(async () => overrides.transcript ?? 'hello world') }
  const llm = { available: overrides.llmAvailable ?? false, complete: vi.fn(async (_request: { user: string }) => 'Rewritten text.') }
  const openUrl = vi.fn(async (_url: string) => {
    if (overrides.openFails) throw new Error('no browser')
  })
  const controller = new DictationController({ settings: () => settings, helper, asr, llm, db, capture, openUrl } as unknown as ControllerDeps)

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
  return { controller, capture, helper, asr, llm, db, openUrl, pills, history, record, settle, sessionId }
}

const command = async (t: ReturnType<typeof setup>) => {
  t.controller.handleShortcut('command', 'down')
  t.record()
  vi.advanceTimersByTime(900)
  t.controller.handleShortcut('command', 'up')
  await t.settle()
}

/** `settle` runs every timer, so the notice has already timed out back to idle; this finds what was shown. */
const lastNotice = (t: ReturnType<typeof setup>) => t.pills.filter((pill) => pill.phase === 'notice').at(-1)

beforeEach(() => {
  vi.useFakeTimers()
  logged.length = 0
})
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

  it('opens apps without a language model', async () => {
    const t = setup({ llmAvailable: false, transcript: 'open spotify' })
    await command(t)
    expect(t.helper.launchApp).toHaveBeenCalledWith('SpotifyAB.SpotifyMusic!Spotify')
    expect(t.helper.paste).not.toHaveBeenCalled()
    expect(t.helper.copySelection).not.toHaveBeenCalled()
    expect(t.history[0]).toMatchObject({ mode: 'command', status: 'action', finalText: 'Opened Spotify', wordCount: 0 })
    expect(t.pills.find((pill) => pill.notice)?.notice?.text).toBe('Opening Spotify')
  })

  it('guards the copy keystroke with the required foreground process, like the paste', async () => {
    const t = setup({ llmAvailable: true, transcript: 'make this shorter' })
    t.controller.requireForeground = 'electron'
    await command(t)
    expect(t.helper.copySelection).toHaveBeenCalledWith('electron')
    expect(t.helper.paste).toHaveBeenCalledWith('Rewritten text.', expect.objectContaining({ expectProcess: 'electron' }))
  })

  it('copies without a process guard when none is required', async () => {
    const t = setup({ llmAvailable: true, transcript: 'make this shorter' })
    await command(t)
    expect(t.helper.copySelection).toHaveBeenCalledWith(undefined)
  })

  it('reports how many installed apps it knows', async () => {
    const t = setup()
    await expect(t.controller.appsReady()).resolves.toBe(2)
  })

  it('explains that writing commands need a language model', async () => {
    const t = setup({ llmAvailable: false, transcript: 'make this shorter' })
    await command(t)
    expect(t.helper.paste).not.toHaveBeenCalled()
    expect(lastNotice(t)).toMatchObject({ phase: 'notice', notice: { kind: 'error', text: expect.stringMatching(/language model/) } })
  })

  it('does nothing with an empty command', async () => {
    const t = setup({ llmAvailable: true, transcript: 'um' })
    await command(t)
    expect(t.llm.complete).not.toHaveBeenCalled()
    expect(t.helper.paste).not.toHaveBeenCalled()
    expect(t.helper.copySelection).not.toHaveBeenCalled()
    expect(t.history[0]).toMatchObject({ mode: 'command', status: 'empty', wordCount: 0, usedLlm: false })
    expect(lastNotice(t)?.notice?.text).toBe("Didn't catch a command. Try again.")
  })

  it('starts reading the window text as soon as the session starts', async () => {
    const t = setup({ llmAvailable: true })
    t.controller.handleShortcut('command', 'down')
    await vi.advanceTimersByTimeAsync(0)
    expect(t.helper.getWindowText).toHaveBeenCalledWith(16_000)
    expect(t.asr.transcribe).not.toHaveBeenCalled()
  })

  it('does not read window text when no model could use it', async () => {
    const t = setup({ llmAvailable: false, transcript: 'open spotify' })
    await command(t)
    expect(t.helper.getWindowText).not.toHaveBeenCalled()
  })

  it('does not read window text when something is selected', async () => {
    const t = setup({ llmAvailable: true, transcript: 'make this shorter', selected: 'Some text.', windowText: 'Other text' })
    await command(t)
    expect(t.helper.getWindowText).not.toHaveBeenCalled()
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).not.toContain('screen_text')
  })

  it('does not read window text when app awareness is off', async () => {
    const t = setup({ llmAvailable: true, transcript: 'reply to this', windowText: 'Can we meet Friday?', settings: { useAppContext: false } })
    await command(t)
    expect(t.helper.getWindowText).not.toHaveBeenCalled()
    expect(t.helper.getContext).toHaveBeenCalledOnce()
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).not.toContain('screen_text')
  })

  it('reads the context but no window text when dictation without app awareness is upgraded to a command', async () => {
    const t = setup({ llmAvailable: true, transcript: 'reply to this', windowText: 'Can we meet Friday?', settings: { useAppContext: false } })
    t.controller.handleShortcut('ptt', 'down')
    expect(t.helper.getContext).not.toHaveBeenCalled()
    vi.advanceTimersByTime(80)
    t.controller.handleShortcut('command', 'down')
    t.record()
    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('command', 'up')
    t.controller.handleShortcut('ptt', 'up')
    await t.settle()
    expect(t.helper.getContext).toHaveBeenCalledOnce()
    expect(t.helper.getWindowText).not.toHaveBeenCalled()
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).not.toContain('screen_text')
  })

  it('reads the context and the window text once when dictation is upgraded to a command', async () => {
    const t = setup({ llmAvailable: true, transcript: 'reply to this', windowText: 'Can we meet Friday?' })
    t.controller.handleShortcut('ptt', 'down')
    vi.advanceTimersByTime(80)
    t.controller.handleShortcut('command', 'down')
    t.record()
    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('command', 'up')
    t.controller.handleShortcut('ptt', 'up')
    await t.settle()
    expect(t.helper.getContext).toHaveBeenCalledOnce()
    expect(t.helper.getWindowText).toHaveBeenCalledOnce()
    const request = t.llm.complete.mock.calls[0]![0] as { user: string }
    expect(request.user).toContain('<screen_text>\nCan we meet Friday?\n</screen_text>')
    expect(t.history[0]).toMatchObject({ appName: 'Notepad' })
  })
})

describe('command actions', () => {
  it('searches the web with the configured engine', async () => {
    const t = setup({ transcript: 'search for standing desks', settings: { searchUrl: 'https://duckduckgo.com/?q={query}' } })
    await command(t)
    expect(t.openUrl).toHaveBeenCalledWith('https://duckduckgo.com/?q=standing%20desks')
    expect(t.history[0]).toMatchObject({ status: 'action', finalText: 'https://duckduckgo.com/?q=standing%20desks' })
  })

  it('opens a spoken domain', async () => {
    const t = setup({ transcript: 'go to github dot com' })
    await command(t)
    expect(t.openUrl).toHaveBeenCalledWith('https://github.com')
  })

  it('opens a saved site before an app with the same name', async () => {
    const t = setup({ transcript: 'open spotify' })
    t.db.saveSite({ name: 'Spotify', url: 'https://open.spotify.com' })
    await command(t)
    expect(t.openUrl).toHaveBeenCalledWith('https://open.spotify.com')
    expect(t.helper.launchApp).not.toHaveBeenCalled()
  })

  it('searches when nothing matches and says so', async () => {
    const t = setup({ transcript: 'open photoshop' })
    await command(t)
    expect(t.openUrl).toHaveBeenCalledWith('https://www.google.com/search?q=photoshop')
    expect(t.pills.some((pill) => /No app called "photoshop"/.test(pill.notice?.text ?? ''))).toBe(true)
  })

  it('treats "go to" with nothing to open as a writing command', async () => {
    const t = setup({ llmAvailable: true, transcript: 'go to the next paragraph', windowText: 'First paragraph.' })
    await command(t)
    expect(t.openUrl).not.toHaveBeenCalled()
    expect(t.helper.launchApp).not.toHaveBeenCalled()
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).toMatch(/<instruction>\nGo to the next paragraph\.?\n<\/instruction>/)
    expect(t.helper.paste).toHaveBeenCalledWith('Rewritten text.', expect.anything())
  })

  it('treats "pull up" with nothing to open as a writing command', async () => {
    const t = setup({ llmAvailable: true, transcript: 'pull up the hem' })
    await command(t)
    expect(t.openUrl).not.toHaveBeenCalled()
    expect(t.llm.complete).toHaveBeenCalledOnce()
  })

  it('says a "go to" with nothing to open needs a language model, and searches nothing', async () => {
    const t = setup({ llmAvailable: false, transcript: 'go to the next paragraph' })
    await command(t)
    expect(t.openUrl).not.toHaveBeenCalled()
    expect(lastNotice(t)).toMatchObject({ notice: { kind: 'error', text: expect.stringMatching(/needs a language model/) } })
  })

  it('still opens a domain or an app after "go to"', async () => {
    const site = setup({ transcript: 'go to example.com' })
    await command(site)
    expect(site.openUrl).toHaveBeenCalledWith('https://example.com')

    const app = setup({ transcript: 'go to spotify' })
    await command(app)
    expect(app.helper.launchApp).toHaveBeenCalledWith('SpotifyAB.SpotifyMusic!Spotify')
  })

  it('searches the web while the app list has never loaded', async () => {
    const t = setup({ transcript: 'open spotify' })
    t.helper.listApps.mockResolvedValue(null)
    await command(t)
    expect(t.helper.launchApp).not.toHaveBeenCalled()
    expect(t.openUrl).toHaveBeenCalledWith('https://www.google.com/search?q=spotify')
  })

  it('reports an app that fails to launch', async () => {
    const t = setup({ transcript: 'open spotify', launchOk: false })
    await command(t)
    expect(t.history[0]).toMatchObject({ status: 'failed', error: 'launch_failed' })
    expect(lastNotice(t)).toMatchObject({ phase: 'notice', notice: { kind: 'error' } })
  })

  it('puts the link on the clipboard when the browser will not open', async () => {
    const t = setup({ transcript: 'go to example.com', openFails: true })
    await command(t)
    expect(t.capture.copyToClipboard).toHaveBeenCalledWith('https://example.com')
    expect(t.history[0]).toMatchObject({ status: 'failed', error: 'open_failed' })
  })

  it('launches nothing when cancelled mid-way', async () => {
    const t = setup({ transcript: 'open spotify' })
    let release: (apps: Array<{ name: string; id: string }>) => void = () => undefined
    t.helper.listApps.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    t.controller.handleShortcut('command', 'down')
    t.record()
    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('command', 'up')
    t.controller.captureStopped(t.sessionId())
    await vi.advanceTimersByTimeAsync(10)
    expect(t.helper.listApps).toHaveBeenCalledOnce()
    t.controller.handleShortcut('cancel', 'down')
    release([{ name: 'Spotify', id: 'SpotifyAB.SpotifyMusic!Spotify' }])
    await vi.runAllTimersAsync()
    expect(t.helper.launchApp).not.toHaveBeenCalled()
    expect(t.openUrl).not.toHaveBeenCalled()
    expect(t.history).toHaveLength(0)
  })

  it('finishes an app launch that was already dispatched when cancel comes', async () => {
    const t = setup({ transcript: 'open spotify' })
    let release: (ok: boolean) => void = () => undefined
    t.helper.launchApp.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    t.controller.handleShortcut('command', 'down')
    t.record()
    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('command', 'up')
    t.controller.captureStopped(t.sessionId())
    await vi.advanceTimersByTimeAsync(10)
    expect(t.helper.launchApp).toHaveBeenCalledOnce()
    t.controller.handleShortcut('cancel', 'down')
    release(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(t.history[0]).toMatchObject({ status: 'action', finalText: 'Opened Spotify' })
    expect(lastNotice(t)?.notice?.text).toBe('Opening Spotify')
  })

  it('finishes opening a URL that was already dispatched when cancel comes', async () => {
    const t = setup({ transcript: 'go to github dot com' })
    let release: () => void = () => undefined
    t.openUrl.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    t.controller.handleShortcut('command', 'down')
    t.record()
    vi.advanceTimersByTime(900)
    t.controller.handleShortcut('command', 'up')
    t.controller.captureStopped(t.sessionId())
    await vi.advanceTimersByTimeAsync(10)
    expect(t.openUrl).toHaveBeenCalledOnce()
    t.controller.handleShortcut('cancel', 'down')
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(t.history[0]).toMatchObject({ status: 'action', finalText: 'https://github.com' })
    expect(lastNotice(t)?.notice?.text).toBe('Opening github.com')
  })

  it('keeps targets out of the log', async () => {
    const t = setup({ transcript: 'open spotify' })
    await command(t)
    await vi.advanceTimersByTimeAsync(5000)
    t.asr.transcribe.mockResolvedValue('search for standing desks')
    await command(t)
    expect(t.helper.launchApp).toHaveBeenCalledOnce()
    expect(t.openUrl).toHaveBeenCalledOnce()
    expect(logged.filter((line) => line.startsWith('Command done'))).toHaveLength(2)
    expect(logged.filter((line) => /spotify|standing desks/i.test(line))).toEqual([])
  })
})

describe('command writing', () => {
  it('runs a saved command on the selection and counts its use', async () => {
    const t = setup({ llmAvailable: true, transcript: 'Spanish', selected: 'Good morning' })
    await command(t)
    const request = t.llm.complete.mock.calls[0]![0] as { user: string }
    expect(request.user).toContain('<selected_text>\nGood morning\n</selected_text>')
    expect(request.user).toContain('Translate this into Spanish')
    expect(t.db.listCommands().find((entry) => entry.name === 'Spanish')?.uses).toBe(1)
    expect(t.helper.paste).toHaveBeenCalledWith('Rewritten text.', expect.anything())
  })

  it('sends no window text with a saved command on a selection', async () => {
    const t = setup({ llmAvailable: true, transcript: 'Spanish', selected: 'Good morning', windowText: 'Other text' })
    await command(t)
    expect(t.helper.getWindowText).not.toHaveBeenCalled()
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).not.toContain('screen_text')
  })

  it('passes extra spoken words to a saved command', async () => {
    const t = setup({ llmAvailable: true, transcript: 'Shorten, keep the deadline', selected: 'Long text' })
    await command(t)
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).toContain('Also: keep the deadline')
  })

  it('uses window text when nothing is selected with the local model', async () => {
    const t = setup({ llmAvailable: true, transcript: 'reply to this', windowText: 'Can we meet Friday?' })
    await command(t)
    expect(t.helper.getWindowText).toHaveBeenCalledWith(16_000)
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).toContain('<screen_text>\nCan we meet Friday?\n</screen_text>')
  })

  it('pastes nothing over the selection when the edit was cut short', async () => {
    const t = setup({ llmAvailable: true, transcript: 'make this shorter', selected: 'A very long passage.' })
    t.llm.complete.mockRejectedValueOnce(new TruncatedError('A very lo'))
    await command(t)
    expect(t.helper.paste).not.toHaveBeenCalled()
    expect(t.capture.copyToClipboard).not.toHaveBeenCalled()
    expect(t.pills.some((pill) => pill.notice?.text === 'The edit was cut short, so nothing was replaced. Select a shorter passage.')).toBe(true)
  })

  it('inserts nothing and says the reply was too long when a write was cut short', async () => {
    const t = setup({ llmAvailable: true, transcript: 'reply to this', windowText: 'Can we meet Friday?' })
    t.llm.complete.mockRejectedValueOnce(new TruncatedError('Hi, Friday wor'))
    await command(t)
    expect(t.helper.paste).not.toHaveBeenCalled()
    expect(t.capture.copyToClipboard).not.toHaveBeenCalled()
    const notices = t.pills.map((pill) => pill.notice?.text)
    expect(notices).toContain('The reply was too long and got cut off, so nothing was inserted. Ask for something shorter.')
    expect(notices.some((text) => /nothing was replaced/.test(text ?? ''))).toBe(false)
  })

  it('drops a leading ellipsis from written text, but not from an edited selection', async () => {
    const write = setup({ llmAvailable: true, transcript: 'continue this paragraph', windowText: 'To make up for it, we started' })
    write.llm.complete.mockResolvedValueOnce('... using daily stand-ups.')
    await command(write)
    expect(write.helper.paste).toHaveBeenCalledWith('using daily stand-ups.', expect.anything())

    const edit = setup({ llmAvailable: true, transcript: 'make this shorter', selected: '…and so on, and so forth.' })
    edit.llm.complete.mockResolvedValueOnce('…and so on.')
    await command(edit)
    expect(edit.helper.paste).toHaveBeenCalledWith('…and so on.', expect.anything())
  })

  it('refuses a selection too long for the built-in model', async () => {
    const t = setup({ llmAvailable: true, transcript: 'make this shorter', selected: 'a'.repeat(10_004) })
    await command(t)
    expect(t.llm.complete).not.toHaveBeenCalled()
    expect(lastNotice(t)?.notice?.text).toBe('The selection is too long for command mode. Select a shorter passage.')
  })

  it('gives a remote model up to 12,000 selected characters', async () => {
    const fits = setup({ llmAvailable: true, transcript: 'make this shorter', selected: 'a'.repeat(12_000), settings: { llmProvider: 'remote' } })
    await command(fits)
    expect(fits.llm.complete).toHaveBeenCalledOnce()

    const tooLong = setup({ llmAvailable: true, transcript: 'make this shorter', selected: 'a'.repeat(12_001), settings: { llmProvider: 'remote' } })
    await command(tooLong)
    expect(tooLong.llm.complete).not.toHaveBeenCalled()
    expect(lastNotice(tooLong)?.notice?.text).toBe('The selection is too long for command mode. Select a shorter passage.')
  })

  it('never reads window text for a remote model, and says so once', async () => {
    const t = setup({ llmAvailable: true, transcript: 'reply to this', windowText: 'secret', settings: { llmProvider: 'remote' } })
    await command(t)
    expect(t.helper.getWindowText).not.toHaveBeenCalled()
    expect((t.llm.complete.mock.calls[0]![0] as { user: string }).user).not.toContain('screen_text')
    expect(t.pills.some((pill) => /only shared with the built-in model/.test(pill.notice?.text ?? ''))).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    await command(t)
    expect(t.pills.filter((pill) => /only shared with the built-in model/.test(pill.notice?.text ?? ''))).toHaveLength(1)
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
