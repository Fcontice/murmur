// Starts the native helper and exercises the read-only requests: node scripts/helper-smoke.cjs
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const exe = path.join(__dirname, '..', 'resources', 'helper', 'murmur-helper.exe')
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const lines = readline.createInterface({ input: child.stdout })
lines.on('line', (line) => console.log('<-', line.length > 600 ? `${line.slice(0, 600)}…` : line))

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
send({ id: 1, type: 'hello' })
send({ id: 2, type: 'setShortcuts', bindings: [{ id: 'ptt', keys: [17, 91] }, { id: 'cancel', keys: [27], whileCapturing: true }] })
send({ id: 3, type: 'getContext', maxChars: 200 })
// Must be refused without touching the clipboard or pressing anything: no such process is in front.
send({ id: 4, type: 'paste', text: 'should never be pasted', expectProcess: 'no-such-process-name' })
setTimeout(() => send({ type: 'quit' }), 1500)
child.on('exit', (code) => console.log('exit', code))
