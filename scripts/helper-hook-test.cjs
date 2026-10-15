// Checks the global keyboard hook against the real OS by pressing modifier-only chords through
// SendInput: node scripts/helper-hook-test.cjs
// Only modifier keys are pressed, so nothing is typed into whatever window has focus.
const { spawn } = require('node:child_process')
const path = require('node:path')
const readline = require('node:readline')

const CTRL = 0xa2, WIN = 0x5b, ALT = 0xa4
const exe = path.join(__dirname, '..', 'resources', 'helper', 'gloop-voice-helper.exe')
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, GLOOP_VOICE_HELPER_TEST: '1' } })

const events = []
const replies = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  if (typeof message.id === 'number') replies.get(message.id)?.(message)
  else if (message.event === 'shortcut') events.push(`${message.id}:${message.phase}`)
  else if (message.event === 'otherKey') events.push('otherKey')
})

let nextId = 1
const request = (type, fields = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    replies.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
  })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function scenario(name, sequence, expected) {
  events.length = 0
  const reply = await request('testKeys', { sequence, delayMs: 60 })
  await sleep(250)
  const ok = JSON.stringify(events) === JSON.stringify(expected)
  const foreground = reply.foreground?.process ?? ''
  const startMenu = /StartMenuExperienceHost|SearchHost|SearchApp/i.test(foreground)
  console.log(`${ok && !startMenu ? 'PASS' : 'FAIL'}  ${name}\n      events: ${events.join(', ') || '(none)'}${ok ? '' : `\n      wanted: ${expected.join(', ')}`}${startMenu ? '\n      the Start menu opened: Win was not masked' : ''}`)
  return ok && !startMenu
}

async function main() {
  await sleep(500)
  await request('setShortcuts', {
    bindings: [
      { id: 'ptt', keys: [0x11, 0x5b] },
      { id: 'command', keys: [0x11, 0x5b, 0x12] },
      { id: 'cancel', keys: [0x1b], whileCapturing: true },
    ],
  })

  const results = [
    await scenario('hold and release Ctrl+Win', [CTRL, WIN, -WIN, -CTRL], ['ptt:down', 'ptt:up']),
    await scenario('keys pressed in the other order', [WIN, CTRL, -CTRL, -WIN], ['ptt:down', 'ptt:up']),
    await scenario('Ctrl alone does nothing', [CTRL, -CTRL], []),
    await scenario('adding Alt upgrades to command mode', [CTRL, WIN, ALT, -ALT, -WIN, -CTRL], ['ptt:down', 'command:down', 'command:up', 'ptt:up']),
    await scenario('double tap', [CTRL, WIN, -WIN, -CTRL, CTRL, WIN, -WIN, -CTRL], ['ptt:down', 'ptt:up', 'ptt:down', 'ptt:up']),
  ]

  child.stdin.write('{"type":"quit"}\n')
  process.exitCode = results.every(Boolean) ? 0 : 1
}

main()
