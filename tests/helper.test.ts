import { describe, expect, it, vi } from 'vitest'
import { Helper } from '../src/main/helper'

// helper.ts pulls in electron through these; the tests never start the native process.
vi.mock('../src/main/log', () => ({ logger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }))
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

  it('is unavailable when the request itself fails', async () => {
    const { helper } = stubbed(async () => Promise.reject(new Error('Helper is not running')))
    expect(await helper.getWindowText(4000)).toEqual({ text: '', elapsedMs: 0, source: 'unavailable' })
  })
})
