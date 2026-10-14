import type { SavedCommand } from '@shared/types'

const OPEN_TRIGGERS = ['open up', 'open', 'launch', 'go to', 'pull up'] as const
const SEARCH_TRIGGERS = ['search the web for', 'search google for', 'search for', 'look up', 'google'] as const

export type OpenTrigger = (typeof OPEN_TRIGGERS)[number]

export type CommandRoute =
  | { kind: 'open'; target: string; trigger: OpenTrigger }
  | { kind: 'search'; query: string }
  | { kind: 'saved'; command: SavedCommand; extra: string }
  | { kind: 'write'; instruction: string }
  | { kind: 'empty' }

/**
 * Triggers that are also everyday writing phrases ("go to the next paragraph", "pull up the hem"). When what
 * follows names no site, app or domain, the command is a writing instruction rather than a web search.
 */
export const LOOSE_OPEN_TRIGGERS: ReadonlySet<OpenTrigger> = new Set(['go to', 'pull up'])
/** An unknown open target becomes a web search, so a false "open" fires a browser: keep this strict. */
const MAX_OPEN_WORDS = 6
/** Words that point at the selection rather than name a place or a query. */
const NOT_A_TARGET = /^(?:the|a|an|my|it|this|that|these|those|up|(?:it|this|that) up)$/i
/**
 * "open X and make it…" or "go to X, write…" is an instruction about writing, not a place. A short
 * "and" stays part of a name ("Barnes and Noble").
 */
const CLAUSE = /,|\band\b(?=(?:\s+\S+){2,})|\b(?:then|write|make|about)\b/i
const DOMAIN = /^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i
const LEADING_FILLER = /^(?:(?:um+|uh+|er+|okay|ok|so|hey|please|can you|could you|would you)\b[\s,]*)+/i
/** The lookbehind keeps this linear on long whitespace runs. */
const TRAILING_POLITENESS = /(?<![\s,])[\s,]+(?:please|thanks|thank you)$/i
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' }
/** What people add after a saved command's name that carries no extra instruction. */
const EMPTY_EXTRA = /^(?:(?:this|that|it)[\s,]*)?(?:please|thanks|thank you)?$/i

/** Strips what speech recognition and politeness add around a command. */
function tidy(text: string): string {
  return text.trim().replace(/[.!?,;:]+$/, '').trim()
}

/** Applied to transcripts and saved names alike, so a name matches however it was typed. */
function normalize(text: string): string {
  return tidy(text.normalize('NFC').trim().replace(LEADING_FILLER, ''))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** What follows the spoken words, minus separators and politeness. */
function rest(text: string, matched: number): string {
  return tidy(text.slice(matched).replace(/^[\s,.]+/, '').replace(TRAILING_POLITENESS, ''))
}

/** Removes quotes only when one pair wraps the whole thing, so "the Beatles'" survives. */
function unquote(text: string): string {
  const close = QUOTE_PAIRS[text[0] ?? '']
  const inner = text.slice(1, -1)
  return close && text.length > 1 && text.endsWith(close) && !inner.includes(close) ? tidy(inner) : text
}

/** "Open. Spotify." still starts with "open", but "open.ai" does not. */
function triggerMatch(text: string, trigger: string): RegExpExecArray | null {
  return new RegExp(`^${escapeRegExp(trigger)}(?:$|[\\s,]|\\.(?=\\s|$))`, 'i').exec(text)
}

function afterTrigger<T extends string>(text: string, triggers: readonly T[]): { trigger: T; spoken: string } | null {
  for (const trigger of triggers) {
    const match = triggerMatch(text, trigger)
    if (match) return { trigger, spoken: unquote(rest(text, match[0].length)) }
  }
  return null
}

function openTarget(spoken: string): string | null {
  if (spoken.split(/\s+/).length > MAX_OPEN_WORDS) return null
  const target = spoken.replace(/^(?:the|a|an)\b[\s,]*/i, '')
  if (!target || NOT_A_TARGET.test(target) || /^(?:with|by)\b/i.test(target)) return null
  if (!DOMAIN.test(target) && CLAUSE.test(target)) return null
  return target
}

function searchQuery(text: string): string | null {
  const query = afterTrigger(text, SEARCH_TRIGGERS)?.spoken
  if (!query || NOT_A_TARGET.test(query)) return null
  // "google docs" is a search for Google Docs, not for "docs".
  const bare = /^(google)[\s,]+(\S+)$/i.exec(text)
  return bare ? `${bare[1]} ${bare[2]}` : query
}

/** Decides what a command-mode transcript asks for. Pure, so every phrasing can be tested. */
export function routeCommand(transcript: string, saved: SavedCommand[]): CommandRoute {
  const text = normalize(transcript)
  if (!text) return { kind: 'empty' }

  // Search triggers go first on purpose: "search for" must not be read as anything else.
  const query = searchQuery(text)
  if (query) return { kind: 'search', query }

  const open = afterTrigger(text, OPEN_TRIGGERS)
  const target = open === null ? null : openTarget(open.spoken)
  if (open && target) return { kind: 'open', target, trigger: open.trigger }

  const names = saved
    .map((command) => ({ command, name: normalize(command.name) }))
    .filter(({ name }) => name)
    .sort((a, b) => b.name.length - a.name.length)
  for (const { command, name } of names) {
    const match = new RegExp(`^${escapeRegExp(name)}(?=$|[\\s,.])`, 'iu').exec(text)
    if (match) {
      const extra = rest(text, match[0].length)
      return { kind: 'saved', command, extra: EMPTY_EXTRA.test(extra) ? '' : extra }
    }
  }

  return { kind: 'write', instruction: text }
}

/** Two saved names with the same key would shadow each other in `routeCommand`. */
export function commandKey(name: string): string {
  return normalize(name).toLowerCase()
}

/** A saved command named like an action trigger, or named only with filler, could never run. */
export function reservedNameProblem(name: string): string | null {
  const lower = commandKey(name)
  if (!lower) return 'Use a name with a real word in it, not just "ok" or "please".'
  for (const trigger of [...OPEN_TRIGGERS, ...SEARCH_TRIGGERS]) {
    if (triggerMatch(lower, trigger)) {
      return `Names cannot start with "${trigger}": that phrase opens apps or searches the web.`
    }
  }
  return null
}
