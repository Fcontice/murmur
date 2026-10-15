import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUTS, normaliseSettingsPatch, SEARCH_ENGINES, sameKeys, shortcutLabel, validateSearchUrl, validateShortcut, VK } from '@shared/settings'
import type { HistoryEntry } from '@shared/types'
import { encodeWav, levelFromDb, pcm16ToFloat32, peak, rmsDb, splitAtPauses } from '../src/main/asr/audio'
import { Database, MIGRATIONS } from '../src/main/db'
import { splitOnLineCommands } from '../src/main/text/cleanup'
import { runPipeline, splitForModel } from '../src/main/text/pipeline'

const DAY = 86_400_000

function entry(overrides: Partial<Omit<HistoryEntry, 'id'>> = {}): Omit<HistoryEntry, 'id'> {
  return {
    createdAt: Date.now(), mode: 'dictate', rawText: 'raw words', finalText: 'Final words.', status: 'pasted', error: null,
    appName: 'Notepad', appProcess: 'notepad', durationMs: 60_000, wordCount: 120, asrMs: 100, llmMs: 200, totalMs: 320, usedLlm: true,
    ...overrides,
  }
}

describe('database', () => {
  it('stores, searches and deletes history', () => {
    const db = new Database(':memory:')
    const first = db.addHistory(entry({ finalText: 'Ship the release on Friday.', createdAt: 1000 }), true)
    db.addHistory(entry({ finalText: '100% sure about the budget_v2 file', createdAt: 2000 }), true)

    expect(db.listHistory('', 10, 0).map((item) => item.createdAt)).toEqual([2000, 1000])
    expect(db.listHistory('release', 10, 0)).toHaveLength(1)
    expect(db.listHistory('100%', 10, 0)).toHaveLength(1) // wildcards in the search are literal
    expect(db.listHistory('%', 10, 0)).toHaveLength(1)
    expect(db.listHistory('budget_v2', 10, 0)).toHaveLength(1)
    expect(db.listHistory('', 1, 1)).toHaveLength(1)

    db.deleteHistory(first.id)
    expect(db.listHistory('', 10, 0)).toHaveLength(1)
    db.clearHistory()
    expect(db.listHistory('', 10, 0)).toHaveLength(0)
  })

  it('prunes by age only when retention is set', () => {
    const db = new Database(':memory:')
    const now = Date.now()
    db.addHistory(entry({ createdAt: now - 10 * DAY }), true)
    db.addHistory(entry({ createdAt: now - 1000 }), true)
    expect(db.pruneHistory(0, now)).toBe(0)
    expect(db.pruneHistory(7, now)).toBe(1)
    expect(db.listHistory('', 10, 0)).toHaveLength(1)
  })

  it('keeps totals and streaks independent of saved history', () => {
    const db = new Database(':memory:')
    const now = new Date(2026, 5, 15, 12).getTime()
    db.addHistory(entry({ createdAt: now - 2 * DAY }), false)
    db.addHistory(entry({ createdAt: now - DAY }), false)
    db.addHistory(entry({ createdAt: now, wordCount: 30, durationMs: 30_000 }), true)
    db.clearHistory()

    const stats = db.stats(now)
    expect(stats).toMatchObject({ totalWords: 270, totalDictations: 3, wordsToday: 30, streakDays: 3 })
    expect(stats.wordsPerMinute).toBe(108)
    // Yesterday's streak still stands before today's first dictation.
    expect(db.stats(now + DAY).streakDays).toBe(3)
    expect(db.stats(now + 2 * DAY).streakDays).toBe(0)
  })

  it('validates dictionary entries and tidies aliases', () => {
    const db = new Database(':memory:')
    const saved = db.saveDictionaryEntry({ phrase: '  Supabase ', heardAs: ['super base', ' super base ', 'supabase', ''] })
    expect(saved).toMatchObject({ phrase: 'Supabase', heardAs: ['super base'] })
    expect(() => db.saveDictionaryEntry({ phrase: 'supabase', heardAs: [] })).toThrow(/already/)
    expect(() => db.saveDictionaryEntry({ phrase: '  ', heardAs: [] })).toThrow()

    const edited = db.saveDictionaryEntry({ id: saved.id, phrase: 'Supabase', heardAs: ['supa bass'] })
    expect(edited.heardAs).toEqual(['supa bass'])
    db.recordUses([saved.id], [])
    expect(db.listDictionary()[0]?.uses).toBe(1)
    db.deleteDictionaryEntry(saved.id)
    expect(db.listDictionary()).toHaveLength(0)
  })

  it('validates snippets', () => {
    const db = new Database(':memory:')
    const saved = db.saveSnippet({ trigger: 'my address', expansion: '12 Example Road' })
    expect(() => db.saveSnippet({ trigger: 'My Address', expansion: 'other' })).toThrow(/already exists/)
    expect(() => db.saveSnippet({ trigger: 'x', expansion: '  ' })).toThrow()
    expect(db.saveSnippet({ id: saved.id, trigger: 'my address', expansion: '14 Example Road' }).expansion).toBe('14 Example Road')
  })
})

describe('audio', () => {
  it('converts PCM and measures level', () => {
    const samples = pcm16ToFloat32([new Int16Array([0, 16384]), new Int16Array([-32768])])
    expect([...samples]).toEqual([0, 0.5, -1])
    expect(peak(samples)).toBe(1)
    expect(rmsDb(new Float32Array(100))).toBe(-100)
    expect(rmsDb(new Float32Array(100).fill(1))).toBeCloseTo(0, 5)
    expect(levelFromDb(-100)).toBe(0)
    expect(levelFromDb(-35)).toBeCloseTo(0.5)
    expect(levelFromDb(0)).toBe(1)
  })

  it('cuts long recordings at the quietest point near the limit', () => {
    const rate = 1000
    const audio = new Float32Array(70 * rate).fill(0.5)
    audio.fill(0, 24 * rate, 24 * rate + 400) // a pause at 24 s
    const segments = splitAtPauses(audio, rate, 28, 8)

    expect(segments.reduce((sum, segment) => sum + segment.length, 0)).toBe(audio.length)
    expect(segments.every((segment) => segment.length <= 28 * rate)).toBe(true)
    expect(segments[0]!.length).toBeGreaterThanOrEqual(24 * rate)
    expect(segments[0]!.length).toBeLessThanOrEqual(24 * rate + 400)
    expect(splitAtPauses(audio.subarray(0, 5 * rate), rate)).toHaveLength(1)
  })

  it('writes a valid WAV header', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1]), 16_000)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt32LE(40)).toBe(6)
    expect(wav.readInt16LE(46)).toBe(32767)
    expect(wav.length).toBe(50)
  })
})

describe('shortcuts', () => {
  it('labels chords with modifiers first', () => {
    expect(shortcutLabel([VK.space, VK.win, VK.ctrl])).toBe('Ctrl + Win + Space')
    expect(shortcutLabel(DEFAULT_SHORTCUTS.pasteLast)).toBe('Shift + Alt + Z')
    expect(shortcutLabel([0x70])).toBe('F1')
  })

  it('rejects chords that would fire while typing', () => {
    expect(validateShortcut('ptt', [0x41])).toMatch(/Include/)
    expect(validateShortcut('ptt', [VK.ctrl])).toMatch(/two keys/)
    expect(validateShortcut('ptt', [VK.ctrl, VK.win])).toBeNull()
    expect(validateShortcut('cancel', [VK.escape])).toBeNull()
    expect(validateShortcut('cancel', [VK.ctrl, VK.escape])).toMatch(/single key/)
    expect(sameKeys([VK.win, VK.ctrl], [VK.ctrl, VK.win])).toBe(true)
  })
})

describe('long and structured dictation', () => {
  it('splits spoken line commands into segments', () => {
    expect(splitOnLineCommands('hi dana new line thanks for the draft. New paragraph. see you thursday')).toEqual([
      { text: 'hi dana', breakAfter: '\n' },
      { text: 'thanks for the draft', breakAfter: '\n\n' },
      { text: 'see you thursday', breakAfter: '' },
    ])
    expect(splitOnLineCommands('no commands here')).toEqual([{ text: 'no commands here', breakAfter: '' }])
  })

  it('cleans each segment separately and restores the breaks', async () => {
    const seen: string[] = []
    const out = await runPipeline({
      raw: 'hi dana new line thanks for the draft',
      settings: { editingStrength: 'light', styles: { personal: 'casual', work: 'casual', email: 'formal', other: 'formal' }, smartSpacing: false, voiceCommands: true },
      app: { name: '', process: '', title: '', category: 'other', isTerminal: false },
      textContext: { available: false, before: '', after: '', selected: '', isPassword: false },
      dictionary: [],
      snippets: [],
      complete: async (request) => {
        const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(request.user)![1]!
        seen.push(transcript)
        return transcript[0]!.toUpperCase() + transcript.slice(1) + '.'
      },
    })
    expect(seen).toEqual(['hi dana', 'thanks for the draft'])
    expect(out.text).toBe('Hi dana.\nThanks for the draft.')
  })

  it('breaks very long transcripts into model-sized pieces on sentence boundaries', () => {
    const sentence = 'This sentence has exactly seven words here. '
    const chunks = splitForModel(sentence.repeat(100).trim(), 300)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.endsWith('.'))).toBe(true)
    expect(chunks.join(' ')).toBe(sentence.repeat(100).trim())
    expect(splitForModel('short one')).toEqual(['short one'])
  })
})

describe('search url', () => {
  it('accepts the presets and rejects unusable templates', () => {
    for (const engine of SEARCH_ENGINES) expect(validateSearchUrl(engine.url)).toBeNull()
    expect(validateSearchUrl('https://example.com/search')).toMatch(/\{query\}/)
    expect(validateSearchUrl('javascript:alert({query})')).toMatch(/https/)
    expect(validateSearchUrl('not a url {query}')).toMatch(/valid/)
  })

  it('rejects file URLs and accepts an uppercase scheme or a repeated {query}', () => {
    expect(validateSearchUrl('file:///{query}')).toMatch(/https/)
    expect(validateSearchUrl('HTTPS://www.google.com/search?q={query}')).toBeNull()
    expect(validateSearchUrl('https://example.com/{query}?q={query}')).toBeNull()
  })

  it('trims the search URL in a settings patch and rejects one that cannot be used', () => {
    expect(normaliseSettingsPatch({ searchUrl: '  https://duckduckgo.com/?q={query} \n', sounds: false })).toEqual({
      searchUrl: 'https://duckduckgo.com/?q={query}',
      sounds: false,
    })
    expect(() => normaliseSettingsPatch({ searchUrl: '  https://example.com/search  ' })).toThrow(/\{query\}/)
    expect(() => normaliseSettingsPatch({ searchUrl: 42 as unknown as string })).toThrow('Invalid request.')
    const untouched = { sounds: true }
    expect(normaliseSettingsPatch(untouched)).toBe(untouched)
  })
})

describe('saved commands', () => {
  it('ships with editable examples', () => {
    const db = new Database(':memory:')
    expect(db.listCommands().map((command) => command.name).sort()).toEqual(['Bulletize', 'Shorten', 'Spanish'])
  })

  it('saves, rejects clashes and reserved names, and deletes', () => {
    const db = new Database(':memory:')
    const created = db.saveCommand({ name: '  Friendly  ', prompt: 'Make this warmer.' })
    expect(created).toMatchObject({ name: 'Friendly', prompt: 'Make this warmer.', uses: 0 })
    expect(() => db.saveCommand({ name: 'friendly', prompt: 'x' })).toThrow(/already/)
    expect(() => db.saveCommand({ name: 'Open sesame', prompt: 'x' })).toThrow(/open/i)
    expect(() => db.saveCommand({ name: 'X', prompt: '  ' })).toThrow(/instruction/i)
    expect(() => db.saveCommand({ name: ' ', prompt: 'x' })).toThrow(/name/i)
    db.saveCommand({ id: created.id, name: 'Friendly', prompt: 'Warmer, please.' })
    expect(db.listCommands().find((command) => command.id === created.id)?.prompt).toBe('Warmer, please.')
    db.recordCommandUse(created.id)
    expect(db.listCommands().find((command) => command.id === created.id)?.uses).toBe(1)
    db.deleteCommand(created.id)
    expect(db.listCommands().some((command) => command.id === created.id)).toBe(false)
  })

  it('treats names the router cannot tell apart as clashes', () => {
    const db = new Database(':memory:')
    const fix = db.saveCommand({ name: 'Fix', prompt: 'Fix the grammar.' })
    expect(() => db.saveCommand({ name: 'Please fix', prompt: 'x' })).toThrow(/already/)
    expect(() => db.saveCommand({ name: 'fix.', prompt: 'x' })).toThrow(/already/)
    expect(db.saveCommand({ id: fix.id, name: 'Fix.', prompt: 'Fix the grammar.' }).name).toBe('Fix.')
    expect(db.saveCommand({ name: 'Fix it', prompt: 'x' }).name).toBe('Fix it')
  })

  it('bounds name and instruction length', () => {
    const db = new Database(':memory:')
    expect(() => db.saveCommand({ name: 'n'.repeat(41), prompt: 'x' })).toThrow(/40/)
    expect(() => db.saveCommand({ name: 'Long', prompt: 'p'.repeat(1001) })).toThrow(/1000/)
    expect(db.saveCommand({ name: 'n'.repeat(40), prompt: 'p'.repeat(1000) }).prompt).toHaveLength(1000)
  })

  it('refuses to update a command that no longer exists', () => {
    const db = new Database(':memory:')
    expect(() => db.saveCommand({ id: 'gone', name: 'Ghost', prompt: 'x' })).toThrow('That command no longer exists.')
  })
})

describe('sites', () => {
  it('saves http(s) sites only and rejects duplicate names', () => {
    const db = new Database(':memory:')
    expect(db.listSites()).toEqual([])
    const gmail = db.saveSite({ name: 'Gmail', url: 'mail.google.com' })
    expect(gmail).toMatchObject({ name: 'Gmail', url: 'https://mail.google.com' })
    expect(() => db.saveSite({ name: 'gmail', url: 'https://x.com' })).toThrow(/already/)
    expect(() => db.saveSite({ name: 'Bad', url: 'javascript:alert(1)' })).toThrow(/web address/)
    expect(() => db.saveSite({ name: 'Files', url: 'file:///c:/' })).toThrow(/web address/)
    db.deleteSite(gmail.id)
    expect(db.listSites()).toEqual([])
  })

  it('refuses addresses that hide the real host behind a user name', () => {
    const db = new Database(':memory:')
    expect(() => db.saveSite({ name: 'Sneaky', url: 'https://user:pw@x.com' })).toThrow(/user name or password/)
    expect(() => db.saveSite({ name: 'Sneaky', url: 'mail.google.com@evil.com' })).toThrow(/user name or password/)
  })

  it('accepts a port and still refuses other schemes', () => {
    const db = new Database(':memory:')
    expect(db.saveSite({ name: 'Local', url: 'example.com:8080' }).url).toBe('https://example.com:8080')
    expect(() => db.saveSite({ name: 'Mail', url: 'mailto:someone@example.com' })).toThrow(/web address/)
    expect(() => db.saveSite({ name: 'Script', url: 'JavaScript://x.com/%0Aalert(1)' })).toThrow(/web address/)
  })

  it('treats names the resolver cannot tell apart as clashes', () => {
    const db = new Database(':memory:')
    db.saveSite({ name: 'Éclair', url: 'eclair.example.com' })
    expect(() => db.saveSite({ name: 'éclair', url: 'x.com' })).toThrow(/already/)
    db.saveSite({ name: 'Café', url: 'cafe.example.com' })
    expect(() => db.saveSite({ name: 'Café', url: 'x.com' })).toThrow(/already/)
    const gmail = db.saveSite({ name: 'Gmail', url: 'mail.google.com' })
    expect(() => db.saveSite({ name: 'My Gmail', url: 'x.com' })).toThrow(/already/)
    expect(db.saveSite({ id: gmail.id, name: 'My Gmail', url: 'mail.google.com' }).name).toBe('My Gmail')
    expect(() => db.saveSite({ name: 'My', url: 'x.com' })).toThrow('Use a name with a real word in it.')
  })

  it('bounds name and address length', () => {
    const db = new Database(':memory:')
    expect(() => db.saveSite({ name: 'n'.repeat(41), url: 'x.com' })).toThrow(/40/)
    expect(() => db.saveSite({ name: 'Long', url: `x.com/${'a'.repeat(2000)}` })).toThrow(/2000/)
  })

  it('refuses to update a site that no longer exists', () => {
    const db = new Database(':memory:')
    expect(() => db.saveSite({ id: 'gone', name: 'Ghost', url: 'x.com' })).toThrow('That site no longer exists.')
  })
})

describe('database file', () => {
  /** Opens, reads and closes before any assertion runs, so a failure never leaves the file locked. */
  function read<T>(file: string, query: (db: Database) => T): T {
    const db = new Database(file)
    try {
      return query(db)
    } finally {
      db.close()
    }
  }

  function userVersion(file: string): number {
    const raw = new DatabaseSync(file)
    try {
      return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    } finally {
      raw.close()
    }
  }

  function inTempDir(test: (file: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'gloop-voice-db-'))
    try {
      test(join(dir, 'gloop-voice.sqlite'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('migrates a new file once and reopens it cleanly', () => {
    inTempDir((file) => {
      read(file, () => undefined)
      expect(read(file, (db) => db.listCommands())).toHaveLength(3)
      expect(userVersion(file)).toBe(2)
    })
  })

  it('upgrades a version 1 file without losing history', () => {
    inTempDir((file) => {
      const raw = new DatabaseSync(file)
      try {
        raw.exec(MIGRATIONS[0]!)
        raw.exec('PRAGMA user_version = 1')
        raw.prepare(`INSERT INTO history (id, created_at, mode, raw_text, final_text, status) VALUES ('old', 1000, 'dictate', 'raw', 'Kept.', 'pasted')`).run()
      } finally {
        raw.close()
      }

      const { history, commands, sites } = read(file, (db) => ({ history: db.listHistory('', 10, 0), commands: db.listCommands(), sites: db.listSites() }))
      expect(history.map((item) => [item.id, item.finalText])).toEqual([['old', 'Kept.']])
      expect(commands).toHaveLength(3)
      expect(sites).toEqual([])
      expect(userVersion(file)).toBe(2)
    })
  })

  it('leaves the file at its old version and unlocked when a migration fails', () => {
    inTempDir((file) => {
      const raw = new DatabaseSync(file)
      try {
        raw.exec(MIGRATIONS[0]!)
        raw.exec('CREATE TABLE sites (id TEXT PRIMARY KEY)')
        raw.exec('PRAGMA user_version = 1')
      } finally {
        raw.close()
      }

      expect(() => new Database(file)).toThrow(/sites/)
      expect(userVersion(file)).toBe(1)
      // Windows refuses to delete a file that is still open.
      expect(() => rmSync(file)).not.toThrow()
    })
  })
})
