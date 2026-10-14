// Starts the native helper and exercises the read-only requests: node scripts/helper-smoke.cjs
// Screen text in replies is printed as its length only.
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const SCREEN = new Set(['before', 'after', 'selected', 'contents', 'title', 'text'])
const redact = (key, value) => (SCREEN.has(key) && typeof value === 'string' ? `<${value.length} chars>` : value)
const show = (line) => {
  try {
    return JSON.stringify(JSON.parse(line), redact)
  } catch {
    return `<unparsed, ${line.length} chars>`
  }
}

const exe = path.join(__dirname, '..', 'resources', 'helper', 'murmur-helper.exe')
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = readline.createInterface({ input: child.stdout })
lines.on('line', (line) => console.log('<-', show(line)))

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
send({ id: 1, type: 'hello' })
send({ id: 2, type: 'setShortcuts', bindings: [{ id: 'ptt', keys: [17, 91] }, { id: 'cancel', keys: [27], whileCapturing: true }] })
send({ id: 3, type: 'getContext', maxChars: 200 })
// Must be refused without touching the clipboard or pressing anything: no such process is in front.
send({ id: 4, type: 'paste', text: 'should never be pasted', expectProcess: 'no-such-process-name' })
setTimeout(() => send({ type: 'quit' }), 1500)
child.on('exit', (code) => console.log('exit', code))
