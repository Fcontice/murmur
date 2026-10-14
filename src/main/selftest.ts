/**
 * End-to-end check of the running app, used during development:
 *   MURMUR_SELFTEST=<output dir> MURMUR_USER_DATA=<scratch dir> electron .
 * It drives the real helper, speech model and language model, dictating recorded clips into the app's
 * own "Try it" box so no other application is touched. Physical key presses are the one thing it
 * cannot simulate, because the keyboard hook deliberately ignores injected input.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AsrService } from './asr/service'
import type { DictationController } from './controller'
import type { Database } from './db'
import type { Helper } from './helper'
import type { LlmService } from './llm/service'
import type { SettingsStore } from './settings-store'

export interface SelfTestContext {
  outDir: string
  controller: DictationController
  helper: Helper
  asr: AsrService
  llm: LlmService
  db: Database
  settings: SettingsStore
  pill: BrowserWindow
  showHub: () => BrowserWindow
}

interface StepResult {
  name: string
  ok: boolean
  detail: unknown
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(100)
  }
}

function readWavPcm(file: string): Int16Array {
  const buffer = readFileSync(file)
  const dataAt = buffer.indexOf('data', 12, 'ascii')
  if (dataAt < 0) throw new Error(`${file} has no data chunk`)
  const length = buffer.readUInt32LE(dataAt + 4)
  const bytes = buffer.subarray(dataAt + 8, dataAt + 8 + length)
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)))
}

async function processIds(image: string): Promise<Set<number>> {
  const { execFile } = await import('node:child_process')
  const out = await new Promise<string>((resolve) => execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], (_e, stdout) => resolve(stdout ?? '')))
  return new Set([...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((match) => Number(match[1])))
}

/**
 * Asks each process the test started to close (WM_CLOSE, never /F), repeating until it has gone: a close sent
 * before the app has made its window reaches nothing. Returns the PIDs that would not close.
 */
async function closeProcesses(image: string, pids: number[]): Promise<number[]> {
  const { execFile } = await import('node:child_process')
  let running = pids
  for (let attempt = 0; attempt < 20 && running.length > 0; attempt++) {
    await Promise.all(running.map((pid) => new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(pid)], () => resolve()))))
    await sleep(250)
    const now = await processIds(image)
    running = running.filter((pid) => now.has(pid))
  }
  return running
}

export async function runSelfTest(context: SelfTestContext): Promise<void> {
  const { outDir, controller, helper, asr, llm, db, settings, pill } = context
  mkdirSync(outDir, { recursive: true })
  // Lets UI Automation read the page text of our own window, which the screen-aware command step needs.
  app.setAccessibilitySupportEnabled(true)
  const fixtures = join(app.getAppPath(), 'tests', 'fixtures')
  const results: StepResult[] = []

  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      results.push({ name, ok: true, detail: await run() })
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  }

  settings.update({ sounds: false })
  // Enforced by the helper at the moment of pasting, so test text can never reach another window.
  controller.requireForeground = 'electron'
  const hub = context.showHub()
  const rendererLog: string[] = []
  hub.webContents.on('console-message', (details) => rendererLog.push(`console[${details.level}] ${details.message}`.slice(0, 400)))
  hub.webContents.on('render-process-gone', (_event, details) => rendererLog.push(`render-process-gone: ${details.reason}`))
  hub.webContents.on('did-start-navigation', (details) => rendererLog.push(`navigation: ${details.url}`))
  const js = async <T>(code: string): Promise<T> => {
    try {
      return (await hub.webContents.executeJavaScript(code, true)) as T
    } catch (error) {
      const page = await hub.webContents.executeJavaScript(`document.body.innerText.slice(0, 200)`, true).catch(() => '(unreadable)')
      throw new Error(`${error instanceof Error ? error.message : String(error)} | page: ${JSON.stringify(page)} | renderer: ${JSON.stringify(rendererLog.slice(-6))}`)
    }
  }
  const shot = async (window: BrowserWindow, name: string) => writeFileSync(join(outDir, `${name}.png`), (await window.webContents.capturePage()).toPNG())

  const isForeground = async () => /electron|murmur/i.test((await helper.getContext(200))?.app.process ?? '')

  const dictate = async (clip: string, mode: 'handsFree' | 'command') => {
    // Windows only lets a background app come forward in a few situations; restoring from
    // minimised is one of them.
    for (let attempt = 0; attempt < 4 && !(await isForeground()); attempt++) {
      hub.setAlwaysOnTop(true)
      hub.minimize()
      await sleep(250)
      hub.restore()
      app.focus({ steal: true })
      hub.focus()
      await sleep(700)
      hub.setAlwaysOnTop(false)
    }
    const focus = await helper.getContext(200)
    if (!/electron|murmur/i.test(focus?.app.process ?? '')) throw new Error(`Murmur is not the foreground app (${focus?.app.process}); skipped to avoid typing elsewhere`)
    controller.audioOverride = readWavPcm(join(fixtures, `${clip}.wav`))
    controller.handleShortcut(mode, 'down')
    await sleep(700)
    controller.handleShortcut(mode, mode === 'command' ? 'up' : 'down')
    await waitFor(() => !controller.busy, 90_000, 'dictation to finish')
    await sleep(700)
    return js<string>(`document.querySelector('.try').value`)
  }

  await step('engines ready', async () => {
    await waitFor(() => helper.status === 'ready', 20_000, 'helper')
    await waitFor(() => asr.state === 'ready' || asr.state === 'failed', 120_000, 'speech model')
    await waitFor(() => llm.state !== 'loading', 240_000, 'language model')
    if (asr.state !== 'ready') throw new Error(asr.detail)
    return { asr: asr.detail, llm: `${llm.state}: ${llm.detail}` }
  })

  await step('screenshots', async () => {
    await waitFor(() => !hub.webContents.isLoading(), 15_000, 'window load')
    await sleep(800)
    await shot(hub, 'onboarding-models')
    await js(`[...document.querySelectorAll('.onboarding-actions .button')].find((b) => b.textContent === 'Continue').click()`)
    await sleep(300)
    await shot(hub, 'onboarding-microphone')
    settings.update({ onboarded: true })
    await sleep(500)
    for (const page of ['Home', 'History', 'Dictionary', 'Snippets', 'Commands', 'Style', 'Settings']) {
      await js(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '${page}').click()`)
      await sleep(400)
      await shot(hub, `hub-${page.toLowerCase()}`)
    }
    await js(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === 'Home').click()`)
    await shot(pill, 'pill-idle')
    return 'saved'
  })

  await step('microphone capture', async () => {
    let chunks = 0
    const count = () => chunks++
    ipcMain.on('capture:chunk', count)
    controller.handleShortcut('handsFree', 'down')
    await sleep(2200)
    const phase = controller.pillState.phase
    await shot(pill, 'pill-listening')
    controller.handleShortcut('cancel', 'down')
    ipcMain.off('capture:chunk', count)
    await sleep(300)
    if (phase !== 'listening') throw new Error(`Recording did not start (pill phase: ${phase}; ${controller.pillState.notice?.text ?? 'no notice'})`)
    if (chunks < 20) throw new Error(`Only ${chunks} audio blocks arrived in 2.2 s`)
    return { chunks, expectedAbout: 50 }
  })
  await sleep(4500) // let the "cancelled" notice clear

  await step('dictation into a text field', async () => {
    await js(`(() => { const box = document.querySelector('.try'); box.value = ''; box.focus() })()`)
    const focus = await js<string>(`JSON.stringify({ hasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.className })`)
    const target = await helper.getContext(200)
    const text = await dictate('dictation', 'handsFree')
    if (!/wednesday/i.test(text)) {
      throw new Error(`Unexpected text: ${JSON.stringify(text)}; focus ${focus}; target ${JSON.stringify(target)}; last history ${JSON.stringify(db.listHistory('', 1, 0)[0])}`)
    }
    return { text, fillersRemoved: !/\b(um|uh)\b/i.test(text), correctionApplied: !/tuesday/i.test(text) }
  })

  await step('second dictation continues with correct spacing', async () => {
    const text = await dictate('dictation', 'handsFree')
    if (/\S {2,}\S/.test(text) || !/[.!?] \S/.test(text)) throw new Error(`Spacing looks wrong: ${JSON.stringify(text)}`)
    return { text }
  })

  await step('snippet expansion', async () => {
    db.saveSnippet({ trigger: 'my calendar link', expansion: 'https://cal.example.com/me' })
    await js(`(() => { const box = document.querySelector('.try'); box.value = ''; box.focus() })()`)
    const text = await dictate('snippet', 'handsFree')
    if (!text.includes('https://cal.example.com/me')) throw new Error(`Unexpected text: ${JSON.stringify(text)}`)
    return { text }
  })

  await step('command mode rewrites the selection', async () => {
    if (!llm.available) throw new Error(`Language model not available: ${llm.detail}`)
    const original = 'hey can u send the file when u get a sec'
    await js(`(() => { const box = document.querySelector('.try'); box.value = ${JSON.stringify(original)}; box.focus(); box.select() })()`)
    const text = await dictate('command', 'command')
    if (!text.trim() || text.trim() === original) throw new Error(`Selection was not rewritten: ${JSON.stringify(text)}`)
    return { before: original, after: text }
  })

  const showPage = async (page: string) => {
    await js(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === '${page}').click()`)
    await sleep(400)
  }

  /** Actions never paste; the empty "Try it" box only keeps the focus inside Murmur's own window. */
  const commandClip = async (clip: string) => {
    await showPage('Home')
    await js(`(() => { const box = document.querySelector('.try'); box.value = ''; box.focus() })()`)
    const urls: string[] = []
    controller.urlOverride = (url) => urls.push(url)
    try {
      await dictate(clip, 'command')
    } finally {
      controller.urlOverride = null
    }
    return { urls, last: db.listHistory('', 1, 0)[0] }
  }

  await step('command: search for', async () => {
    const { urls, last } = await commandClip('search')
    if (urls[0] !== 'https://www.google.com/search?q=standing%20desks') throw new Error(`Unexpected URL ${JSON.stringify(urls)}; heard ${JSON.stringify(last?.rawText)}`)
    return { url: urls[0], status: last?.status }
  })

  await step('command: go to a spoken domain', async () => {
    const { urls, last } = await commandClip('goto')
    if (urls[0] !== 'https://example.com') throw new Error(`Unexpected URL ${JSON.stringify(urls)}; heard ${JSON.stringify(last?.rawText)}`)
    return { url: urls[0], status: last?.status }
  })

  await step('command: open an installed app', async () => {
    const before = await processIds('charmap.exe')
    const { urls, last } = await commandClip('open-charmap')
    let mine: number[] = []
    for (let attempt = 0; attempt < 20 && mine.length === 0; attempt++) {
      await sleep(250)
      mine = [...(await processIds('charmap.exe'))].filter((pid) => !before.has(pid))
    }
    const leftOpen = await closeProcesses('charmap.exe', mine)
    if (urls.length > 0) throw new Error(`Searched instead of opening the app: ${JSON.stringify(urls)}; heard ${JSON.stringify(last?.rawText)}`)
    if (last?.status !== 'action' || mine.length === 0) throw new Error(`Character Map did not open: ${JSON.stringify(last)}`)
    return { finalText: last.finalText, launched: mine.length, leftOpen }
  })

  await step('command: saved command on a selection', async () => {
    if (!llm.available) throw new Error(`Language model not available: ${llm.detail}`)
    await showPage('Home')
    await js(`(() => { const box = document.querySelector('.try'); box.value = 'Good morning, see you at the meeting.'; box.focus(); box.select() })()`)
    const text = await dictate('saved-spanish', 'command')
    if (!/buen|reuni/i.test(text)) throw new Error(`Not translated: ${JSON.stringify(text)}; last history ${JSON.stringify(db.listHistory('', 1, 0)[0])}`)
    return { text, uses: db.listCommands().find((entry) => entry.name === 'Spanish')?.uses }
  })

  await step('command: summarize what is on screen', async () => {
    if (!llm.available) throw new Error(`Language model not available: ${llm.detail}`)
    await showPage('Home')
    // Right before the box, so it sits in the text read before the caret.
    await js(`(() => {
      const box = document.querySelector('.try')
      let note = document.getElementById('selftest-article')
      if (!note) { note = document.createElement('p'); note.id = 'selftest-article'; box.parentElement.insertBefore(note, box) }
      note.textContent = 'Lisbon will host the 2027 climate summit. Organisers expect 40,000 visitors over five days and plan two temporary ferry lines.'
      box.value = ''; box.focus()
    })()`)
    let text: string
    try {
      text = await dictate('summarize', 'command')
    } finally {
      await js(`document.getElementById('selftest-article')?.remove()`)
    }
    if (!/lisbon/i.test(text)) throw new Error(`Summary did not use the screen text: ${JSON.stringify(text)}; last history ${JSON.stringify(db.listHistory('', 1, 0)[0])}`)
    return { text }
  })

  await step('history and stats', async () => {
    const history = db.listHistory('', 10, 0)
    await js(`[...document.querySelectorAll('.nav-item')].find((b) => b.textContent === 'History').click()`)
    await sleep(500)
    await shot(hub, 'hub-history-filled')
    return {
      entries: history.map((entry) => ({
        mode: entry.mode, status: entry.status, heard: entry.rawText, written: entry.finalText, asrMs: entry.asrMs, llmMs: entry.llmMs, usedLlm: entry.usedLlm,
      })),
      stats: db.stats(),
    }
  })

  await step('command history', async () => {
    // The History screenshot above already shows these entries with their action badges.
    const commands = db.listHistory('', 50, 0).filter((entry) => entry.mode === 'command')
    if (commands.length === 0) throw new Error('No command entries in history')
    return commands.map((entry) => ({ status: entry.status, heard: entry.rawText, result: entry.finalText, error: entry.error, usedLlm: entry.usedLlm }))
  })

  app.quit()
}
