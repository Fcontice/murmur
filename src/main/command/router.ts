import type { SavedCommand } from '@shared/types'

export type CommandRoute =
  | { kind: 'open'; target: string }
  | { kind: 'search'; query: string }
  | { kind: 'saved'; command: SavedCommand; extra: string }
  | { kind: 'write'; instruction: string }
  | { kind: 'empty' }

const OPEN_TRIGGERS = ['open up', 'open', 'launch', 'go to', 'pull up']
const SEARCH_TRIGGERS = ['search the web for', 'search google for', 'search for', 'look up', 'google']
/** An unknown open target becomes a web search, so a false "open" fires a browser: keep this strict. */
const MAX_OPEN_WORDS = 6
const NOT_A_TARGET = /^(?:the|a|an|my|it|this|that|these|those|up)$/i
/** "open X and make it…" or "go to X, write…" is an instruction about writing, not a place. */
const CLAUSE = /,|\b(?:and|then|write|make|about)\b/i
/** TRAILING_POLITENESS is quadratic on long whitespace runs; no real command is this long. */
const MAX_TRANSCRIPT = 2000
const LEADING_FILLER = /^(?:(?:um+|uh+|er+|okay|ok|so|hey|please|can you|could you|would you)\b[\s,]*)+/i
const TRAILING_POLITENESS = /[\s,]+(?:please|thanks|thank you)$/i
const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g
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
  return tidy(tidy(text.slice(matched).replace(/^[\s,.]+/, '').replace(TRAILING_POLITENESS, '')).replace(QUOTES, ''))
}

function afterTrigger(text: string, triggers: string[]): string | null {
  for (const trigger of triggers) {
    // "Open. Spotify." still counts, but "open.ai" does not.
    const match = new RegExp(`^${escapeRegExp(trigger)}(?:$|[\\s,]|\\.(?=\\s|$))`, 'i').exec(text)
    if (match) return rest(text, match[0].length)
  }
  return null
}

function openTarget(spoken: string): string | null {
  if (spoken.split(/\s+/).length > MAX_OPEN_WORDS) return null
  const target = spoken.replace(/^(?:the|a|an)\b[\s,]*/i, '')
  if (!target || NOT_A_TARGET.test(target) || CLAUSE.test(target) || /^(?:with|by)\b/i.test(target)) return null
  return target
}

/** Decides what a command-mode transcript asks for. Pure, so every phrasing can be tested. */
export function routeCommand(transcript: string, saved: SavedCommand[]): CommandRoute {
  const text = normalize(transcript.slice(0, MAX_TRANSCRIPT))
  if (!text) return { kind: 'empty' }

  // Search triggers go first on purpose: "search for" must not be read as anything else.
  const searchQuery = afterTrigger(text, SEARCH_TRIGGERS)
  if (searchQuery) return { kind: 'search', query: /^google\s+\S+$/i.test(text) ? text : searchQuery }

  const spokenTarget = afterTrigger(text, OPEN_TRIGGERS)
  const target = spokenTarget === null ? null : openTarget(spokenTarget)
  if (target) return { kind: 'open', target }

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

/** A saved command named like an action trigger, or named only with filler, could never run. */
export function reservedNameProblem(name: string): string | null {
  const lower = normalize(name).toLowerCase()
  if (!lower) return 'Use a name with a real word in it, not just "ok" or "please".'
  for (const trigger of [...OPEN_TRIGGERS, ...SEARCH_TRIGGERS]) {
    if (lower.startsWith(trigger) && (lower === trigger || /^[\s,.]/.test(lower.slice(trigger.length)))) {
      return `Names cannot start with "${trigger}": that phrase opens apps or searches the web.`
    }
  }
  return null
}
