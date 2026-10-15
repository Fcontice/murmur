// Checks the helper's command-mode requests against the real OS: node scripts/helper-commands-test.cjs [helper.exe]
// Launches Character Map and a window of its own, and closes only the processes it started. Never opens the
// user's apps or documents. Screen text is measured, never printed.
const { execFileSync, spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const exe = process.argv[2] ?? path.join(__dirname, '..', 'resources', 'helper', 'gloop-voice-helper.exe')
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

const MARKER = 'Gloop Voice window text check: the quick brown fox.'
// A form of the test's own holding the marker in a RichEdit 5.0 control, which UI Automation exposes as a
// Document with a TextPattern (the stock WinForms RichTextBox uses RichEdit 2.0, which it does not).
const FIXTURE = [
  'Add-Type -AssemblyName System.Windows.Forms',
  "Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Windows.Forms;',
  'public class GloopVoiceRichEdit50 : RichTextBox {',
  '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryW(string name);',
  '  protected override CreateParams CreateParams {',
  '    get { LoadLibraryW("msftedit.dll"); CreateParams p = base.CreateParams; p.ClassName = "RICHEDIT50W"; return p; }',
  '  }',
  '}',
  "'@",
  "$f = New-Object Windows.Forms.Form; $f.Text = 'Gloop Voice window text check'; $f.Width = 520; $f.Height = 200; $f.TopMost = $true",
  "$t = New-Object GloopVoiceRichEdit50; $t.Dock = 'Fill'; $t.ReadOnly = $true; $t.Text = $env:GLOOP_VOICE_MARKER",
  '$f.Controls.Add($t); $f.Add_Shown({ $f.Activate(); $t.Focus() })',
  '[Windows.Forms.Application]::Run($f)',
].join('\n')

/** Shows the test's own window, waits for it to be in front, and checks getWindowText finds the marker. */
async function ownWindowCheck() {
  const name = 'getWindowText reads a window with a text document'
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(FIXTURE, 'utf16le').toString('base64')
  const form = spawn(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
    stdio: 'ignore',
    env: { ...process.env, GLOOP_VOICE_MARKER: MARKER },
  })
  // Close our window however the run ends, including Ctrl+C.
  const killForm = () => {
    if (form.exitCode === null) form.kill()
  }
  const onSigint = () => {
    killForm()
    process.exit(130)
  }
  process.once('exit', killForm)
  process.once('SIGINT', onSigint)
  let startError = null
  form.on('error', (error) => {
    startError = error
  })
  const exited = new Promise((resolve) => form.on('exit', resolve))
  try {
    let front = false
    for (let attempt = 0; attempt < 32 && !front && form.exitCode === null && !startError; attempt++) {
      await sleep(250)
      const context = await request('getContext', { maxChars: 1 })
      front = context.app?.pid === form.pid
    }
    if (startError) return skip(name, `PowerShell could not start the test window (${startError.code ?? startError.message})`)
    if (!front) {
      return skip(name, 'the test window did not come to the foreground (Windows keeps focus with the app in use; run from a focused terminal)')
    }
    const window = await request('getWindowText', { maxChars: 6000 }, 5000)
    const found = (window.text ?? '').includes(MARKER)
    if (!window.ok && window.error === 'elevated') return skip(name, 'the foreground window is elevated')
    check(name, window.ok && found, `marker found: ${found ? 'yes' : 'no'}; ${window.source ?? window.error}: ${window.text?.length ?? 0} chars in ${window.elapsedMs} ms`)
  } finally {
    killForm() // our own PowerShell process, by its handle
    await Promise.race([exited, sleep(3000)])
    process.removeListener('exit', killForm)
    process.removeListener('SIGINT', onSigint)
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
    const quoted = await request('launchApp', { appId: `${charmap.id}" /select` })
    const comma = await request('launchApp', { appId: `${charmap.id},/root` })
    check(
      'launchApp refuses ids that could escape the argument',
      [quoted, comma].every((reply) => reply.ok === false && reply.error === 'invalid_id'),
      `${JSON.stringify(quoted)} ${JSON.stringify(comma)}`,
    )
  }

  if (charmap) {
    const before = pids('charmap.exe')
    const launched = await request('launchApp', { appId: charmap.id })
    const mine = await newPids('charmap.exe', before)
    check('launchApp starts Character Map', launched.ok && mine.length > 0, JSON.stringify(launched))
    await close('charmap.exe', mine)
  }

  // Must be refused before any key is sent: no such process is in front, so Ctrl+C never reaches this terminal.
  const copied = await request('copySelection', { expectProcess: 'no-such-process-name' })
  check('copySelection refuses when the expected process is not in front', copied.ok && copied.text === '', JSON.stringify({ ok: copied.ok, chars: copied.text?.length }))

  const window = await request('getWindowText', { maxChars: 6000 }, 5000)
  if (!window.ok && window.error === 'elevated') {
    skip('getWindowText answers within its budget', 'the foreground window is elevated')
  } else {
    check('getWindowText answers within its budget', window.ok && window.elapsedMs <= 1700, `${window.source ?? window.error}: ${window.text?.length ?? 0} chars in ${window.elapsedMs} ms`)
    check('getWindowText respects maxChars', (window.text ?? '').length <= 6000)
  }

  await ownWindowCheck()

  child.stdin.write('{"type":"quit"}\n')
  process.exitCode = results.every(Boolean) ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  child.kill()
  process.exitCode = 1
})
