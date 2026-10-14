import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Helper } from '../src/main/helper'

const logged = vi.hoisted(() => [] as string[])
// helper.ts pulls in electron through these; the tests never start the native process.
vi.mock('../src/main/log', () => {
  const record = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  return { logger: () => ({ info: record, warn: record, error: record }) }
})
vi.mock('../src/main/paths', () => ({ resourcePath: () => 'missing-helper.exe' }))

/** A Helper whose wire requests are answered by `reply` instead of the native process. */
function stubbed(reply: (type: string, fields: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const helper = new Helper()
  const request = vi.spyOn(helper as any, 'request').mockImplementation((...args: unknown[]) => reply(args[0] as string, (args[1] ?? {}) as Record<string, unknown>))
  return { helper, request }
}

describe('Helper.listApps', () => {
  it('keeps only entries with a non-empty name and id', async () => {
    const { helper, request } = stubbed(async () => ({
      ok: true,
      apps: [{ name: 'Spotify', id: 'spotify.id' }, { name: '', id: 'x' }, { name: 'No id' }, { name: 'Bad', id: 7 }, null, 'text', { name: 'Notepad', id: 'np', extra: 1 }],
    }))
    expect(await helper.listApps()).toEqual([{ name: 'Spotify', id: 'spotify.id' }, { name: 'Notepad', id: 'np' }])
    expect(request).toHaveBeenCalledWith('listApps', {}, 9000)
  })

  it('returns null when the helper fails or the reply has no list', async () => {
    expect(await stubbed(async () => ({ ok: false, error: 'timeout' })).helper.listApps()).toBeNull()
    expect(await stubbed(async () => ({ ok: true })).helper.listApps()).toBeNull()
    expect(await stubbed(async () => Promise.reject(new Error('Helper is not running'))).helper.listApps()).toBeNull()
  })
})

describe('Helper.launchApp', () => {
  it('sends the app id as appId, since id is the request id', async () => {
    const { helper, request } = stubbed(async () => ({ ok: true }))
    expect(await helper.launchApp('Spotify.id')).toBe(true)
    expect(request).toHaveBeenCalledWith('launchApp', { appId: 'Spotify.id' }, 9000)
  })

  it('reports failure as false', async () => {
    expect(await stubbed(async () => ({ ok: false, error: 'unknown_app' })).helper.launchApp('x')).toBe(false)
    expect(await stubbed(async () => Promise.reject(new Error('timed out'))).helper.launchApp('x')).toBe(false)
  })
})

describe('Helper.getWindowText', () => {
  it('returns the text and where it came from', async () => {
    const { helper, request } = stubbed(async () => ({ ok: true, text: 'hello', source: 'document', elapsedMs: 42 }))
    expect(await helper.getWindowText(4000)).toEqual({ text: 'hello', elapsedMs: 42, source: 'document' })
    expect(request).toHaveBeenCalledWith('getWindowText', { maxChars: 4000 }, 2500)
  })

  it('maps a helper error to empty text with the error as the source', async () => {
    const { helper } = stubbed(async () => ({ ok: false, error: 'elevated', elapsedMs: 3 }))
    expect(await helper.getWindowText(4000)).toEqual({ text: '', elapsedMs: 3, source: 'elevated' })
  })

  it('never reports a NaN elapsed time', async () => {
    const { helper } = stubbed(async () => ({ ok: false, error: 'busy', elapsedMs: 'soon' }))
    expect(await helper.getWindowText(4000)).toEqual({ text: '', elapsedMs: 0, source: 'busy' })
  })

  it('is unavailable when the request itself fails', async () => {
    const { helper } = stubbed(async () => Promise.reject(new Error('Helper is not running')))
    expect(await helper.getWindowText(4000)).toEqual({ text: '', elapsedMs: 0, source: 'unavailable' })
  })
})

describe('Helper version', () => {
  beforeEach(() => void (logged.length = 0))

  const ready = (version?: string) => (new Helper() as any).onLine(JSON.stringify({ event: 'ready', version }))

  it('warns when the helper speaks another protocol version', () => {
    ready('1')
    expect(logged).toContain('Helper version 1, expected 2: rebuild the helper')
  })

  it('stays quiet for the expected version', () => {
    ready('2')
    expect(logged.filter((line) => line.startsWith('Helper version'))).toEqual([])
  })
})

describe('Helper unavailable reads', () => {
  beforeEach(() => void (logged.length = 0))

  it('logs a busy or timed-out read once per reason, without any text', async () => {
    const { helper } = stubbed(async (type) =>
      type === 'getWindowText' ? { ok: false, error: 'timeout', elapsedMs: 1500 } : { ok: true, app: {}, text: { available: false, reason: 'busy' } },
    )
    await helper.getWindowText(4000)
    await helper.getWindowText(4000)
    await helper.getContext(600)
    await helper.getContext(600)
    expect(logged).toEqual(['getWindowText unavailable: timeout', 'getContext unavailable: busy'])
  })

  it('does not log other reasons', async () => {
    const { helper } = stubbed(async (type) =>
      type === 'getWindowText' ? { ok: false, error: 'elevated' } : { ok: true, app: {}, text: { available: false, reason: 'no_focus' } },
    )
    await helper.getWindowText(4000)
    await helper.getContext(600)
    expect(logged).toEqual([])
  })
})
