import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { Settings } from '@shared/types'
import { TruncatedError } from '../src/main/llm/errors'
import { LlmService } from '../src/main/llm/service'
import type { ModelManager } from '../src/main/models'

vi.mock('../src/main/log', () => ({ logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }))
vi.mock('../src/main/paths', () => ({ resourcePath: () => 'missing.exe', userFile: () => 'missing.pid' }))

const request = { system: 'sys', shots: [] as Array<[string, string]>, user: 'hi', maxTokens: 16 }

function reply(content: string, finishReason: string | null) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A service talking to a custom OpenAI-compatible server. */
function remote(): LlmService {
  const service = new LlmService({} as ModelManager)
  service.configure({ ...DEFAULT_SETTINGS, llmProvider: 'remote', llmRemote: { baseUrl: 'http://remote/v1', apiKey: '', model: 'm' } } as Settings)
  return service
}

/** A service whose local llama-server is already up (the start-up itself is not under test). */
function local(): LlmService {
  const service = new LlmService({} as ModelManager)
  Object.assign(service, {
    settings: { ...DEFAULT_SETTINGS, llmProvider: 'local' },
    server: { child: null, modelId: 'x', endpoint: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'local' } },
    state: 'ready',
  })
  return service
}

afterEach(() => vi.unstubAllGlobals())

describe('LlmService.complete', () => {
  it.each([
    ['remote', remote],
    ['local', local],
  ])('returns the text when the %s model finished', async (_name, make) => {
    reply('Done.', 'stop')
    await expect(make().complete(request)).resolves.toBe('Done.')
  })

  it.each([
    ['remote', remote],
    ['local', local],
  ])('throws TruncatedError, carrying the partial text, when the %s model hit max_tokens', async (_name, make) => {
    reply('Half a sen', 'length')
    const error = await make().complete(request).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TruncatedError)
    expect((error as TruncatedError).partial).toBe('Half a sen')
  })

  it('accepts a server that reports no finish reason', async () => {
    reply('Done.', null)
    await expect(remote().complete(request)).resolves.toBe('Done.')
  })
})

describe('LlmService.test', () => {
  it('counts a reply cut off by its tiny token limit as working', async () => {
    reply('ready', 'length')
    const result = await remote().test()
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/ready/)
  })

  it('reports an HTTP error as not working', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect((await remote().test()).ok).toBe(false)
  })
})
