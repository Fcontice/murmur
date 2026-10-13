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

export async function runSelfTest(context: SelfTestContext): Promise<void> {
  const { outDir, controller, helper, asr, llm, db, settings, pill } = context
  mkdirSync(outDir, { recursive: true })
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
    for (const page of ['Home', 'History', 'Dictionary', 'Snippets', 'Style', 'Settings']) {
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

  app.quit()
}
