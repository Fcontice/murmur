import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { userFile } from './paths'

const MAX_BYTES = 2 * 1024 * 1024
let queue: Promise<void> = Promise.resolve()

function write(level: string, scope: string, message: string, detail?: unknown): void {
  const extra = detail === undefined ? '' : ` ${detail instanceof Error ? detail.stack ?? detail.message : JSON.stringify(detail)}`
  const line = `${new Date().toISOString()} ${level} [${scope}] ${message}${extra}\n`
  if (level === 'ERROR') console.error(line.trimEnd())
  else console.log(line.trimEnd())

  const file = userFile('logs', 'gloop-voice.log')
  queue = queue
    .then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const size = await stat(file).then((s) => s.size, () => 0)
      if (size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => undefined)
      await appendFile(file, line)
    })
    .catch(() => undefined)
}

/** Dictated text is never logged; callers pass lengths and timings instead. */
export function logger(scope: string) {
  return {
    info: (message: string, detail?: unknown) => write('INFO', scope, message, detail),
    warn: (message: string, detail?: unknown) => write('WARN', scope, message, detail),
    error: (message: string, detail?: unknown) => write('ERROR', scope, message, detail),
  }
}
