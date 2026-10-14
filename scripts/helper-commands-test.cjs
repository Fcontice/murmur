// Checks the helper's command-mode requests against the real OS: node scripts/helper-commands-test.cjs [helper.exe]
// Launches Character Map and Notepad, and closes only the processes it started. Screen text is measured, never printed.
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const exe = process.argv[2] ?? path.join(__dirname, '..', 'resources', 'helper', 'murmur-helper.exe')
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const replies = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  if (typeof message.id === 'number') replies.get(message.id)?.(message)
})
let nextId = 1
const request = (type, fields = {}, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`${type} timed out`)), timeoutMs)
    replies.set(id, (message) => (clearTimeout(timer), resolve(message)))
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
  })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pids = (name) => {
  const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  return new Set([...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((match) => Number(match[1])))
}
const newPids = async (name, before, attempts = 20) => {
  let mine = []
  for (let attempt = 0; attempt < attempts && mine.length === 0; attempt++) {
    await sleep(250)
    mine = [...pids(name)].filter((pid) => !before.has(pid))
  }
  return mine
}
/**
 * Asks each process we started to close (WM_CLOSE, never /F), repeating until it has gone: a close sent before
 * the app has made its window reaches nothing.
 */
const close = async (name, mine) => {
  for (let attempt = 0; attempt < 20 && mine.length > 0; attempt++) {
    for (const pid of mine) {
      try {
        execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' })
      } catch {
        // already gone
      }
    }
    await sleep(250)
    const running = pids(name)
    mine = mine.filter((pid) => running.has(pid))
  }
  if (mine.length > 0) console.log(`WARN  could not close ${name} (PID ${mine.join(', ')}) that this test started`)
}

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}
const skip = (name, reason) => console.log(`SKIP  ${name}\n      ${reason}`)

/** Saved tabs that Windows 11 Notepad reopens at start ("continue where you left off"). Counted, never read. */
const notepadSavedTabs = () => {
  const dir = path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe', 'LocalState', 'TabState')
  try {
    return fs.readdirSync(dir).filter((file) => file.endsWith('.bin')).length
  } catch {
    return 0
  }
}

/**
 * Opens a temp file in a fresh Notepad and checks the window text contains its marker. Never types into it.
 * Skipped when Notepad is running (the file would open in the user's window) or has saved tabs (a fresh
 * Notepad would reopen the user's documents next to ours).
 */
async function notepadCheck() {
  const name = 'getWindowText reads Notepad'
  const marker = 'Murmur window text check: the quick brown fox.'
  const before = pids('Notepad.exe')
  if (before.size > 0) return skip(name, 'Notepad is already running; it would open the file in the user\'s window')
  if (notepadSavedTabs() > 0) return skip(name, 'Notepad has saved tabs; a fresh Notepad would reopen the user\'s documents')

  const file = path.join(os.tmpdir(), `murmur-window-text-${process.pid}.txt`)
  fs.writeFileSync(file, `${marker}\r\n`)
  let mine = []
  try {
    spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'), [file], { detached: true, stdio: 'ignore' }).unref()
    mine = await newPids('Notepad.exe', before)
    if (mine.length === 0) return skip(name, 'no new Notepad process appeared')

    let front = false
    for (let attempt = 0; attempt < 20 && !front; attempt++) {
      await sleep(250)
      const context = await request('getContext', { maxChars: 1 })
      front = mine.includes(context.app?.pid)
    }
    if (!front) return skip(name, 'Notepad did not come to the foreground')
    await sleep(300) // let the document finish loading

    const window = await request('getWindowText', { maxChars: 6000 }, 5000)
    const found = (window.text ?? '').includes(marker)
    check(name, window.ok && found, `marker found: ${found ? 'yes' : 'no'}; ${window.source}: ${window.text?.length ?? 0} chars in ${window.elapsedMs} ms`)
  } finally {
    await close('Notepad.exe', mine)
    fs.rmSync(file, { force: true })
  }
}

async function main() {
  await sleep(300)
  const started = Date.now()
  const list = await request('listApps')
  const apps = list.apps ?? []
  check('listApps returns installed apps', list.ok && apps.length > 20, `${apps.length} apps in ${Date.now() - started} ms`)
  check('every app has a name and id', apps.every((app) => typeof app.name === 'string' && app.name && typeof app.id === 'string' && app.id))
  const charmap = apps.find((app) => app.name === 'Character Map')
  check('Character Map is listed', Boolean(charmap), charmap?.id)

  const refused = await request('launchApp', { appId: 'C:\\Windows\\System32\\cmd.exe' })
  check('launchApp refuses ids that are not in the list', refused.ok === false && refused.error === 'unknown_app', JSON.stringify(refused))
  if (charmap) {
    const injected = await request('launchApp', { appId: `${charmap.id}" /select,C:\\` })
    check('launchApp refuses ids that could escape the argument', injected.ok === false && injected.error === 'invalid_id', JSON.stringify(injected))
  }

  if (charmap) {
    const before = pids('charmap.exe')
    const launched = await request('launchApp', { appId: charmap.id })
    const mine = await newPids('charmap.exe', before)
    check('launchApp starts Character Map', launched.ok && mine.length > 0, JSON.stringify(launched))
    await close('charmap.exe', mine)
  }

  const window = await request('getWindowText', { maxChars: 6000 }, 5000)
  check('getWindowText answers within its budget', window.ok && window.elapsedMs <= 1700, `${window.source ?? window.error}: ${window.text?.length ?? 0} chars in ${window.elapsedMs} ms`)
  check('getWindowText respects maxChars', (window.text ?? '').length <= 6000)

  await notepadCheck()

  child.stdin.write('{"type":"quit"}\n')
  process.exitCode = results.every(Boolean) ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  child.kill()
  process.exitCode = 1
})
