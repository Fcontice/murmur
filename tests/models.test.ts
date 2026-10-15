import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'gloop-voice-models-'))
vi.mock('../src/main/paths', () => ({ modelsDir: () => join(root, 'models') }))
vi.mock('../src/main/log', () => ({ logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }))

const { ModelManager } = await import('../src/main/models')
type Definition = import('../src/main/models').ModelDefinition

const payload = Buffer.from(Array.from({ length: 200_000 }, (_, index) => index % 251))
const files = new Map<string, Buffer>([['/weights.bin', payload], ['/tokens.txt', Buffer.from('a\nb\n')]])
const requests: Array<{ url: string; range?: string }> = []
let server: Server
let base = ''

beforeAll(async () => {
  // An archive like the GPU runtime pack: a zip holding one file.
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'runtime.exe'), 'pretend binary')
  execFileSync('tar', ['-a', '-cf', join(root, 'pack.zip'), '-C', staging, 'runtime.exe'])
  files.set('/pack.zip', readFileSync(join(root, 'pack.zip')))

  server = createServer((request, response) => {
    const body = files.get(request.url ?? '')
    requests.push({ url: request.url ?? '', range: request.headers.range })
    if (!body) {
      response.writeHead(404).end()
      return
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` }).end(body.subarray(start))
    } else {
      response.writeHead(200).end(body)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  requests.length = 0
  rmSync(join(root, 'models'), { recursive: true, force: true })
})

function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    id: 'test-model', kind: 'asr', name: 'Test model', description: '', languages: '', sizeBytes: payload.length + 4,
    files: [
      { name: 'weights.bin', url: `${base}/weights.bin`, bytes: payload.length },
      { name: 'tokens.txt', url: `${base}/tokens.txt`, bytes: 4 },
    ],
    ...overrides,
  }
}

describe('model downloads', () => {
  it('downloads every file and reports the model installed', async () => {
    const manager = new ModelManager([definition()])
    const installed: string[] = []
    manager.on('installed', (id) => installed.push(id))

    expect(manager.isInstalled('test-model')).toBe(false)
    await manager.download('test-model')

    expect(installed).toEqual(['test-model'])
    expect(manager.list()[0]).toMatchObject({ installed: true, downloading: false, error: null })
    expect(readFileSync(manager.file('test-model', 'weights.bin')).equals(payload)).toBe(true)
    expect(existsSync(`${manager.file('test-model', 'weights.bin')}.part`)).toBe(false)
  })

  it('resumes a partial download instead of starting over', async () => {
    const manager = new ModelManager([definition()])
    mkdirSync(manager.dir('test-model'), { recursive: true })
    writeFileSync(`${manager.file('test-model', 'weights.bin')}.part`, payload.subarray(0, 50_000))

    await manager.download('test-model')

    expect(requests.find((request) => request.url === '/weights.bin')?.range).toBe('bytes=50000-')
    expect(readFileSync(manager.file('test-model', 'weights.bin')).equals(payload)).toBe(true)
  })

  it('rejects a file of the wrong size and can be retried', async () => {
    const manager = new ModelManager([definition({ files: [{ name: 'weights.bin', url: `${base}/weights.bin`, bytes: payload.length + 1 }] })])
    await manager.download('test-model')
    expect(manager.isInstalled('test-model')).toBe(false)
    expect(manager.list()[0]?.error).toMatch(/Download failed/)
    expect(existsSync(`${manager.file('test-model', 'weights.bin')}.part`)).toBe(false)
  })

  it('reports a missing file', async () => {
    const manager = new ModelManager([definition({ files: [{ name: 'gone.bin', url: `${base}/gone.bin`, bytes: 10 }] })])
    await manager.download('test-model')
    expect(manager.list()[0]?.error).toMatch(/404/)
  })

  it('treats a truncated or oversized file on disk as not installed', async () => {
    const manager = new ModelManager([definition()])
    await manager.download('test-model')
    writeFileSync(manager.file('test-model', 'tokens.txt'), 'a\n')
    expect(manager.isInstalled('test-model')).toBe(false)
  })

  it('unpacks archive packs and removes the archives', async () => {
    const pack = files.get('/pack.zip')!
    const manager = new ModelManager([definition({ id: 'pack', kind: 'runtime', extract: 'v1', files: [{ name: 'pack.zip', url: `${base}/pack.zip`, bytes: pack.length }] })])
    await manager.download('pack')

    expect(manager.list()[0]).toMatchObject({ installed: true, error: null })
    expect(readFileSync(manager.file('pack', 'runtime.exe'), 'utf8')).toBe('pretend binary')
    expect(existsSync(manager.file('pack', 'pack.zip'))).toBe(false)

    // A pack unpacked from a different release is not this one.
    writeFileSync(manager.file('pack', '.installed'), 'v0')
    expect(manager.isInstalled('pack')).toBe(false)
  })

  it('removes a model', async () => {
    const manager = new ModelManager([definition()])
    await manager.download('test-model')
    await manager.remove('test-model')
    expect(manager.isInstalled('test-model')).toBe(false)
    expect(existsSync(manager.dir('test-model'))).toBe(false)
  })
})
