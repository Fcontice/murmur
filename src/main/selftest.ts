/**
 * End-to-end check of the running app, used during development:
 *   GLOOP_VOICE_SELFTEST=<output dir> GLOOP_VOICE_USER_DATA=<scratch dir> electron .
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

/**
 * PIDs of running processes with this image name. Rejects when tasklist fails or prints anything unexpected, so a
 * caller never mistakes an unreadable list for "none running" and closes a process the user had open.
 */
async function processIds(image: string): Promise<Set<number>> {
  const { execFile } = await import('node:child_process')
  const out = await new Promise<string>((resolve, reject) =>
    execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], (error, stdout) => (error ? reject(new Error(`tasklist failed: ${error.message}`)) : resolve(stdout))),
  )
  const ids = new Set<number>()
  for (const line of out.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const row = /^"[^"]+","(\d+)",/.exec(line)
    if (row) ids.add(Number(row[1]))
    else if (!line.startsWith('INFO:')) throw new Error(`Unexpected tasklist output: ${JSON.stringify(line.slice(0, 120))}`)
  }
  return ids
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
  const startedAt = Date.now()
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
  // One sink for the whole run, never removed: a command still finishing after its step can never open the browser.
  let urlSink: string[] = []
  controller.urlOverride = (url) => urlSink.push(url)
  // Where the last screen read came from and where the test's own marker word sat in it. Other text is not kept.
  const SCREEN_MARKER = 'Lisbon'
  let lastScreen: { source: string; chars: number; hasMarker: boolean; markerAt: number } | null = null
  const getWindowText = helper.getWindowText.bind(helper)
  helper.getWindowText = async (maxChars) => {
    const result = await getWindowText(maxChars)
    const markerAt = result.text.indexOf(SCREEN_MARKER)
    lastScreen = { source: result.source, chars: result.text.length, hasMarker: markerAt >= 0, markerAt }
    return result
  }
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

  const isForeground = async () => /electron|gloop.?voice/i.test((await helper.getContext(200))?.app.process ?? '')

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
    if (!/electron|gloop.?voice/i.test(focus?.app.process ?? '')) throw new Error(`Gloop Voice is not the foreground app (${focus?.app.process}); skipped to avoid typing elsewhere`)
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
    // "open" resolves against the installed-apps list; without it every app name would become a web search.
    let apps = 0
    const appsDeadline = Date.now() + 20_000
    while ((apps = await controller.appsReady()) === 0) {
      if (Date.now() > appsDeadline) throw new Error('Timed out waiting for the installed-apps list')
      await sleep(500)
    }
    return { asr: asr.detail, llm: `${llm.state}: ${llm.detail}`, apps }
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

  /** Command-mode history written since `since`, newest first. */
  const commandEntries = (since: number) => db.listHistory('', 50, 0).filter((entry) => entry.mode === 'command' && entry.createdAt >= since)

  /** Actions never paste; the empty "Try it" box only keeps the focus inside Gloop Voice's own window. */
  const commandClip = async (clip: string) => {
    await showPage('Home')
    await js(`(() => { const box = document.querySelector('.try'); box.value = ''; box.focus() })()`)
    const stepStart = Date.now()
    const urls: string[] = []
    urlSink = urls
    try {
      await dictate(clip, 'command')
    } finally {
      urlSink = []
    }
    return { urls, last: commandEntries(stepStart)[0] }
  }

  await step('command: search for', async () => {
    const { urls, last } = await commandClip('search')
    if (urls[0] !== 'https://www.google.com/search?q=standing%20desks' || last?.status !== 'action') {
      throw new Error(`Unexpected URL ${JSON.stringify(urls)}; history ${JSON.stringify(last)}`)
    }
    return { url: urls[0], status: last.status }
  })

  await step('command: go to a spoken domain', async () => {
    const { urls, last } = await commandClip('goto')
    if (urls[0] !== 'https://example.com' || last?.status !== 'action') throw new Error(`Unexpected URL ${JSON.stringify(urls)}; history ${JSON.stringify(last)}`)
    return { url: urls[0], status: last.status }
  })

  await step('command: open an installed app', async () => {
    // Rejects if the process list cannot be read, so a Character Map the user had open is never taken for ours.
    const before = await processIds('charmap.exe')
    let mine: number[] = []
    let leftOpen: number[] = []
    let clip: Awaited<ReturnType<typeof commandClip>>
    try {
      clip = await commandClip('open-charmap')
    } finally {
      for (let attempt = 0; attempt < 20 && mine.length === 0; attempt++) {
        await sleep(250)
        mine = [...(await processIds('charmap.exe'))].filter((pid) => !before.has(pid))
      }
      leftOpen = await closeProcesses('charmap.exe', mine)
    }
    const { urls, last } = clip
    if (leftOpen.length > 0) throw new Error(`Could not close the Character Map this test opened (PID ${leftOpen.join(', ')})`)
    if (urls.length > 0) throw new Error(`Searched instead of opening the app: ${JSON.stringify(urls)}; heard ${JSON.stringify(last?.rawText)}`)
    if (last?.status !== 'action' || mine.length === 0) throw new Error(`Character Map did not open: ${JSON.stringify(last)}`)
    return { finalText: last.finalText, launched: mine.length }
  })

  await step('command: saved command on a selection', async () => {
    if (!llm.available) throw new Error(`Language model not available: ${llm.detail}`)
    const uses = () => db.listCommands().find((entry) => entry.id === 'example-spanish')?.uses
    const usesBefore = uses()
    if (usesBefore === undefined) throw new Error('The seeded Spanish command is missing')
    await showPage('Home')
    await js(`(() => { const box = document.querySelector('.try'); box.value = 'Good morning, see you at the meeting.'; box.focus(); box.select() })()`)
    const stepStart = Date.now()
    const text = await dictate('saved-spanish', 'command')
    const last = commandEntries(stepStart)[0]
    if (!/buen|reuni/i.test(text)) throw new Error(`Not translated: ${JSON.stringify(text)}; history ${JSON.stringify(last)}`)
    const usesAfter = uses()
    if (usesAfter !== usesBefore + 1) throw new Error(`Uses went from ${usesBefore} to ${usesAfter}, expected +1`)
    return { text, usesBefore, usesAfter }
  })

  await step('command: summarize what is on screen', async () => {
    if (!llm.available) throw new Error(`Language model not available: ${llm.detail}`)
    await showPage('Home')
    // Like reading an article: the page shows the article and the box, nothing else of the Home page. display:none
    // also takes the hidden parts out of the accessibility tree, so the screen read sees only these two.
    const ARTICLE = [
      'Lisbon will host the 2027 United Nations climate summit, the city council confirmed on Tuesday.',
      'Organisers expect around 40,000 delegates and visitors over the five days of talks.',
      'To ease pressure on the bridges, the city plans two temporary ferry lines across the Tagus.',
      'Hotels near the venue in Parque das Nações are already reporting bookings well above last year.',
    ].join(' ')
    const restorePage = `(() => {
      document.getElementById('selftest-article')?.remove()
      for (const [element, display] of window.__selftestHidden ?? []) element.style.display = display
      window.__selftestHidden = []
    })()`
    let text: string
    let stepStart = 0
    try {
      await js(`(() => {
        const box = document.querySelector('.try')
        const content = document.querySelector('.content')
        const article = document.createElement('article')
        article.id = 'selftest-article'
        const heading = document.createElement('h2')
        heading.textContent = 'Climate summit heads to Portugal'
        const body = document.createElement('p')
        body.textContent = ${JSON.stringify(ARTICLE)}
        article.append(heading, body)
        box.parentElement.insertBefore(article, box)
        window.__selftestHidden = []
        // Up from the box to .content, hide every sibling that is neither the article nor on the path to the box.
        for (let node = box; node && node !== content; node = node.parentElement) {
          for (const sibling of node.parentElement.children) {
            if (sibling === node || sibling === article || sibling.style.display === 'none') continue
            window.__selftestHidden.push([sibling, sibling.style.display])
            sibling.style.display = 'none'
          }
        }
        box.value = ''; box.focus()
      })()`)
      stepStart = Date.now()
      lastScreen = null
      text = await dictate('summarize', 'command')
    } finally {
      await js(restorePage)
    }
    if (!/lisbon/i.test(text)) {
      throw new Error(
        `Summary did not use the screen text: ${JSON.stringify(text)}; llmProvider ${settings.get().llmProvider}; screen ${JSON.stringify(lastScreen ?? 'not read')}; history ${JSON.stringify(commandEntries(stepStart)[0])}`,
      )
    }
    return { text, screen: lastScreen }
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
    const commands = commandEntries(startedAt).reverse()
    const entries = commands.map((entry) => ({ status: entry.status, heard: entry.rawText, result: entry.finalText, error: entry.error, usedLlm: entry.usedLlm }))
    // In run order: the rewrite, search, go to, open, then the saved command and the summary.
    const expected = ['pasted', 'action', 'action', 'action', 'pasted', 'pasted']
    const actions = commands.filter((entry) => entry.status === 'action')
    const pasted = commands.slice(-2)
    if (
      JSON.stringify(commands.map((entry) => entry.status)) !== JSON.stringify(expected) ||
      actions.some((entry) => entry.usedLlm) ||
      pasted.some((entry) => !entry.usedLlm)
    ) {
      throw new Error(`Expected statuses ${JSON.stringify(expected)}, actions without the model and model output pasted; got ${JSON.stringify(entries)}`)
    }
    return entries
  })

  // A command still running would otherwise be cut off mid-paste by the quit.
  await waitFor(() => !controller.busy, 90_000, 'the last command to finish').catch(() => undefined)
  app.quit()
}
