import type { DictionaryEntry, Snippet } from '@shared/types'

const WORD_CHAR = '[\\p{L}\\p{N}]'

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches the phrase as whole words, tolerating any spacing or hyphenation between its parts. */
export function phrasePattern(phrase: string): RegExp | null {
  const parts = phrase.trim().split(/[\s-]+/).filter(Boolean).map(escapeRegex)
  if (parts.length === 0) return null
  return new RegExp(`(?<!${WORD_CHAR})${parts.join('[\\s-]*')}(?!${WORD_CHAR})`, 'giu')
}

export interface DictionaryResult {
  text: string
  usedIds: string[]
}

/** Rewrites misheard forms to the dictionary phrase and fixes the casing of the phrase itself. */
export function applyDictionary(text: string, entries: DictionaryEntry[]): DictionaryResult {
  const rules: Array<{ id: string; from: string; to: string }> = []
  for (const entry of entries) {
    if (!entry.phrase.trim()) continue
    rules.push({ id: entry.id, from: entry.phrase, to: entry.phrase })
    for (const alias of entry.heardAs) {
      if (alias.trim()) rules.push({ id: entry.id, from: alias, to: entry.phrase })
    }
  }
  // Longest first so "open ai api" wins over "open ai".
  rules.sort((a, b) => b.from.length - a.from.length)

  const used = new Set<string>()
  let out = text
  for (const rule of rules) {
    const pattern = phrasePattern(rule.from)
    if (!pattern) continue
    out = out.replace(pattern, (match) => {
      if (match !== rule.to) used.add(rule.id)
      return rule.to
    })
  }
  return { text: out, usedIds: [...used] }
}

function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

export interface SnippetResult {
  text: string
  usedIds: string[]
  /** The whole utterance was a trigger, so the text is exactly the expansion. */
  whole: boolean
}

export function applySnippets(text: string, snippets: Snippet[]): SnippetResult {
  const spoken = normalizeUtterance(text)
  for (const snippet of snippets) {
    if (snippet.trigger.trim() && normalizeUtterance(snippet.trigger) === spoken) {
      return { text: snippet.expansion, usedIds: [snippet.id], whole: true }
    }
  }

  const used = new Set<string>()
  let out = text
  for (const snippet of [...snippets].sort((a, b) => b.trigger.length - a.trigger.length)) {
    const pattern = phrasePattern(snippet.trigger)
    if (!pattern) continue
    out = out.replace(pattern, () => {
      used.add(snippet.id)
      return snippet.expansion
    })
  }
  return { text: out, usedIds: [...used], whole: false }
}
