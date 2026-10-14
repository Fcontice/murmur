import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DictionaryEntry, HistoryEntry, SavedCommand, Site, Snippet, Stats } from '@shared/types'
import { commandKey, reservedNameProblem } from './command/router'

const MAX_NAME = 40
const MAX_PROMPT = 1000
const MAX_URL = 2000

/** Append only: each entry runs once, in order, on the user's existing file. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE history (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    mode TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    final_text TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    app_name TEXT NOT NULL DEFAULT '',
    app_process TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    asr_ms INTEGER NOT NULL DEFAULT 0,
    llm_ms INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    used_llm INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX history_created_at ON history (created_at DESC);

  CREATE TABLE dictionary (
    id TEXT PRIMARY KEY,
    phrase TEXT NOT NULL UNIQUE COLLATE NOCASE,
    heard_as TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE snippets (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL UNIQUE COLLATE NOCASE,
    expansion TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0
  );

  -- Running totals survive history deletion and "don't save history".
  CREATE TABLE daily_stats (
    day TEXT PRIMARY KEY,
    words INTEGER NOT NULL DEFAULT 0,
    dictations INTEGER NOT NULL DEFAULT 0,
    speech_ms INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO commands (id, name, prompt, created_at) VALUES
    ('example-spanish', 'Spanish', 'Translate this into Spanish. Keep names, numbers and formatting.', 0),
    ('example-bulletize', 'Bulletize', 'Turn this into a short bulleted list, one idea per bullet.', 0),
    ('example-shorten', 'Shorten', 'Make this about half as long. Keep every fact, name and request.', 0);

  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
]

type Row = Record<string, unknown>

function localDay(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function toHistory(row: Row): HistoryEntry {
  return {
    id: row.id as string,
    createdAt: row.created_at as number,
    mode: row.mode as HistoryEntry['mode'],
    rawText: row.raw_text as string,
    finalText: row.final_text as string,
    status: row.status as HistoryEntry['status'],
    error: (row.error as string | null) ?? null,
    appName: row.app_name as string,
    appProcess: row.app_process as string,
    durationMs: row.duration_ms as number,
    wordCount: row.word_count as number,
    asrMs: row.asr_ms as number,
    llmMs: row.llm_ms as number,
    totalMs: row.total_ms as number,
    usedLlm: row.used_llm === 1,
  }
}

function parseList(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Accepts "mail.google.com" or a full http(s) address; anything else is refused. */
function normaliseSiteUrl(input: string): string {
  const text = input.trim()
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Enter a web address like mail.google.com.')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) throw new Error('Enter a web address like mail.google.com.')
  // "user@host" hides the real host from a quick read, as in the resolver.
  if (url.username || url.password) throw new Error('Enter a web address like mail.google.com, without a user name or password.')
  return url.toString().replace(/\/$/, '')
}

export class Database {
  private readonly db: DatabaseSync

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[index]!)
        this.db.exec(`PRAGMA user_version = ${index + 1}`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close(): void {
    this.db.close()
  }

  // History

  addHistory(entry: Omit<HistoryEntry, 'id'>, persist: boolean): HistoryEntry {
    const full: HistoryEntry = { ...entry, id: randomUUID() }
    if (entry.wordCount > 0) {
      this.db
        .prepare(
          `INSERT INTO daily_stats (day, words, dictations, speech_ms) VALUES (?, ?, 1, ?)
           ON CONFLICT (day) DO UPDATE SET words = words + excluded.words, dictations = dictations + 1, speech_ms = speech_ms + excluded.speech_ms`,
        )
        .run(localDay(entry.createdAt), entry.wordCount, entry.durationMs)
    }
    if (persist) {
      this.db
        .prepare(
          `INSERT INTO history (id, created_at, mode, raw_text, final_text, status, error, app_name, app_process,
             duration_ms, word_count, asr_ms, llm_ms, total_ms, used_llm)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          full.id, full.createdAt, full.mode, full.rawText, full.finalText, full.status, full.error, full.appName,
          full.appProcess, full.durationMs, full.wordCount, full.asrMs, full.llmMs, full.totalMs, full.usedLlm ? 1 : 0,
        )
    }
    return full
  }

  listHistory(query: string, limit: number, offset: number): HistoryEntry[] {
    const term = query.trim()
    const rows = term
      ? this.db
          .prepare(
            `SELECT * FROM history WHERE final_text LIKE ? ESCAPE '\\' OR raw_text LIKE ? ESCAPE '\\' OR app_name LIKE ? ESCAPE '\\'
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(...Array<string>(3).fill(`%${term.replace(/[\\%_]/g, '\\$&')}%`), limit, offset)
      : this.db.prepare('SELECT * FROM history ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
    return (rows as Row[]).map(toHistory)
  }

  deleteHistory(id: string): void {
    this.db.prepare('DELETE FROM history WHERE id = ?').run(id)
  }

  clearHistory(): void {
    this.db.exec('DELETE FROM history')
  }

  pruneHistory(retentionDays: number, now = Date.now()): number {
    if (retentionDays <= 0) return 0
    const result = this.db.prepare('DELETE FROM history WHERE created_at < ?').run(now - retentionDays * 86_400_000)
    return Number(result.changes)
  }

  stats(now = Date.now()): Stats {
    const totals = this.db
      .prepare('SELECT COALESCE(SUM(words), 0) AS words, COALESCE(SUM(dictations), 0) AS dictations, COALESCE(SUM(speech_ms), 0) AS speech FROM daily_stats')
      .get() as { words: number; dictations: number; speech: number }
    const days = new Set((this.db.prepare('SELECT day FROM daily_stats WHERE words > 0').all() as Array<{ day: string }>).map((row) => row.day))
    const today = localDay(now)
    const todayRow = this.db.prepare('SELECT words FROM daily_stats WHERE day = ?').get(today) as { words: number } | undefined

    // A streak still counts if today has no dictation yet.
    let streak = 0
    const cursor = new Date(now)
    if (!days.has(today)) cursor.setDate(cursor.getDate() - 1)
    while (days.has(localDay(cursor.getTime()))) {
      streak++
      cursor.setDate(cursor.getDate() - 1)
    }

    return {
      totalWords: totals.words,
      totalDictations: totals.dictations,
      totalSpeechMs: totals.speech,
      wordsPerMinute: totals.speech > 0 ? Math.round(totals.words / (totals.speech / 60_000)) : 0,
      streakDays: streak,
      wordsToday: todayRow?.words ?? 0,
    }
  }

  // Dictionary

  listDictionary(): DictionaryEntry[] {
    const rows = this.db.prepare('SELECT * FROM dictionary ORDER BY created_at DESC').all() as Row[]
    return rows.map((row) => ({
      id: row.id as string,
      phrase: row.phrase as string,
      heardAs: parseList(row.heard_as),
      createdAt: row.created_at as number,
      uses: row.uses as number,
    }))
  }

  saveDictionaryEntry(input: { id?: string; phrase: string; heardAs: string[] }): DictionaryEntry {
    const phrase = input.phrase.trim()
    if (!phrase) throw new Error('Enter a word or phrase.')
    const heardAs = [...new Set(input.heardAs.map((alias) => alias.trim()).filter((alias) => alias && alias.toLowerCase() !== phrase.toLowerCase()))]
    const clash = this.db.prepare('SELECT id FROM dictionary WHERE phrase = ? COLLATE NOCASE').get(phrase) as { id: string } | undefined
    if (clash && clash.id !== input.id) throw new Error(`"${phrase}" is already in your dictionary.`)

    if (input.id) {
      this.db.prepare('UPDATE dictionary SET phrase = ?, heard_as = ? WHERE id = ?').run(phrase, JSON.stringify(heardAs), input.id)
    } else {
      input = { ...input, id: randomUUID() }
      this.db.prepare('INSERT INTO dictionary (id, phrase, heard_as, created_at) VALUES (?, ?, ?, ?)').run(input.id!, phrase, JSON.stringify(heardAs), Date.now())
    }
    return this.listDictionary().find((entry) => entry.id === input.id)!
  }

  deleteDictionaryEntry(id: string): void {
    this.db.prepare('DELETE FROM dictionary WHERE id = ?').run(id)
  }

  // Snippets

  listSnippets(): Snippet[] {
    const rows = this.db.prepare('SELECT * FROM snippets ORDER BY created_at DESC').all() as Row[]
    return rows.map((row) => ({
      id: row.id as string,
      trigger: row.trigger as string,
      expansion: row.expansion as string,
      createdAt: row.created_at as number,
      uses: row.uses as number,
    }))
  }

  saveSnippet(input: { id?: string; trigger: string; expansion: string }): Snippet {
    const trigger = input.trigger.trim()
    if (!trigger) throw new Error('Enter the phrase you will say.')
    if (!input.expansion.trim()) throw new Error('Enter the text to insert.')
    const clash = this.db.prepare('SELECT id FROM snippets WHERE trigger = ? COLLATE NOCASE').get(trigger) as { id: string } | undefined
    if (clash && clash.id !== input.id) throw new Error(`A snippet for "${trigger}" already exists.`)

    if (input.id) {
      this.db.prepare('UPDATE snippets SET trigger = ?, expansion = ? WHERE id = ?').run(trigger, input.expansion, input.id)
    } else {
      input = { ...input, id: randomUUID() }
      this.db.prepare('INSERT INTO snippets (id, trigger, expansion, created_at) VALUES (?, ?, ?, ?)').run(input.id!, trigger, input.expansion, Date.now())
    }
    return this.listSnippets().find((snippet) => snippet.id === input.id)!
  }

  deleteSnippet(id: string): void {
    this.db.prepare('DELETE FROM snippets WHERE id = ?').run(id)
  }

  // Saved commands

  listCommands(): SavedCommand[] {
    const rows = this.db.prepare('SELECT * FROM commands ORDER BY created_at DESC, name').all() as Row[]
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      prompt: row.prompt as string,
      createdAt: row.created_at as number,
      uses: row.uses as number,
    }))
  }

  saveCommand(input: { id?: string; name: string; prompt: string }): SavedCommand {
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name) throw new Error('Enter the name you will say.')
    if (!prompt) throw new Error('Enter the instruction to run.')
    if (name.length > MAX_NAME) throw new Error(`Keep the name to ${MAX_NAME} characters or fewer.`)
    if (prompt.length > MAX_PROMPT) throw new Error(`Keep the instruction to ${MAX_PROMPT} characters or fewer.`)
    const reserved = reservedNameProblem(name)
    if (reserved) throw new Error(reserved)
    // Compare the way the router matches, so "Please fix" cannot hide behind "Fix".
    const key = commandKey(name)
    const clash = this.listCommands().find((command) => command.id !== input.id && commandKey(command.name) === key)
    if (clash) throw new Error(`A command called "${clash.name}" already exists.`)

    if (input.id) {
      const result = this.db.prepare('UPDATE commands SET name = ?, prompt = ? WHERE id = ?').run(name, prompt, input.id)
      if (Number(result.changes) === 0) throw new Error('That command no longer exists.')
    } else {
      input = { ...input, id: randomUUID() }
      this.db.prepare('INSERT INTO commands (id, name, prompt, created_at) VALUES (?, ?, ?, ?)').run(input.id!, name, prompt, Date.now())
    }
    return this.listCommands().find((command) => command.id === input.id)!
  }

  deleteCommand(id: string): void {
    this.db.prepare('DELETE FROM commands WHERE id = ?').run(id)
  }

  recordCommandUse(id: string): void {
    this.db.prepare('UPDATE commands SET uses = uses + 1 WHERE id = ?').run(id)
  }

  // Sites

  listSites(): Site[] {
    const rows = this.db.prepare('SELECT * FROM sites ORDER BY name').all() as Row[]
    return rows.map((row) => ({ id: row.id as string, name: row.name as string, url: row.url as string, createdAt: row.created_at as number }))
  }

  saveSite(input: { id?: string; name: string; url: string }): Site {
    const name = input.name.trim()
    if (!name) throw new Error('Enter the name you will say.')
    if (name.length > MAX_NAME) throw new Error(`Keep the name to ${MAX_NAME} characters or fewer.`)
    const url = normaliseSiteUrl(input.url)
    if (url.length > MAX_URL) throw new Error(`Keep the web address to ${MAX_URL} characters or fewer.`)
    const clash = this.db.prepare('SELECT id FROM sites WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined
    if (clash && clash.id !== input.id) throw new Error(`A site called "${name}" already exists.`)

    if (input.id) {
      const result = this.db.prepare('UPDATE sites SET name = ?, url = ? WHERE id = ?').run(name, url, input.id)
      if (Number(result.changes) === 0) throw new Error('That site no longer exists.')
    } else {
      input = { ...input, id: randomUUID() }
      this.db.prepare('INSERT INTO sites (id, name, url, created_at) VALUES (?, ?, ?, ?)').run(input.id!, name, url, Date.now())
    }
    return this.listSites().find((entry) => entry.id === input.id)!
  }

  deleteSite(id: string): void {
    this.db.prepare('DELETE FROM sites WHERE id = ?').run(id)
  }

  recordUses(dictionaryIds: string[], snippetIds: string[]): void {
    const bumpDictionary = this.db.prepare('UPDATE dictionary SET uses = uses + 1 WHERE id = ?')
    const bumpSnippet = this.db.prepare('UPDATE snippets SET uses = uses + 1 WHERE id = ?')
    for (const id of dictionaryIds) bumpDictionary.run(id)
    for (const id of snippetIds) bumpSnippet.run(id)
  }
}
