import type { SavedCommand } from '@shared/types'

export type CommandRoute =
  | { kind: 'open'; target: string }
  | { kind: 'search'; query: string }
  | { kind: 'saved'; command: SavedCommand; extra: string }
  | { kind: 'write'; instruction: string }

const OPEN_TRIGGERS = ['open up', 'open', 'launch', 'go to', 'pull up']
const SEARCH_TRIGGERS = ['search the web for', 'search google for', 'search for', 'look up', 'google']
/** "open X" with a longer X is almost always an instruction about writing ("open the email by thanking…"). */
const MAX_OPEN_WORDS = 6
const LEADING_FILLER = /^(?:(?:um+|uh+|er+|okay|ok|so|hey|please|can you|could you|would you)\b[\s,]*)+/i
const TRAILING_POLITENESS = /[\s,]+(?:please|thanks|thank you)$/i
/** What people add after a saved command's name that carries no extra instruction. */
const EMPTY_EXTRA = /^(?:this|that|it|please|this please|that please|it please)?$/i

/** Strips what speech recognition and politeness add around a command. */
function tidy(text: string): string {
  return text.trim().replace(/[.!?,;:]+$/, '').trim()
}

function afterTrigger(text: string, triggers: string[]): string | null {
  const lower = text.toLowerCase()
  for (const trigger of triggers) {
    if (lower === trigger) return ''
    if (lower.startsWith(`${trigger} `) || lower.startsWith(`${trigger},`)) {
      return tidy(text.slice(trigger.length).replace(/^[\s,]+/, '').replace(TRAILING_POLITENESS, ''))
    }
  }
  return null
}

/** Decides what a command-mode transcript asks for. Pure, so every phrasing can be tested. */
export function routeCommand(transcript: string, saved: SavedCommand[]): CommandRoute {
  const text = tidy(transcript.trim().replace(LEADING_FILLER, ''))

  const searchQuery = afterTrigger(text, SEARCH_TRIGGERS)
  if (searchQuery) return { kind: 'search', query: searchQuery }

  const openTarget = afterTrigger(text, OPEN_TRIGGERS)
  if (openTarget) {
    const target = openTarget.replace(/^the\s+/i, '')
    const words = target.split(/\s+/)
    if (words.length <= MAX_OPEN_WORDS && !/^(with|by)$/i.test(words[0]!)) return { kind: 'open', target }
  }

  const lower = text.toLowerCase()
  const byLength = [...saved].sort((a, b) => b.name.length - a.name.length)
  for (const command of byLength) {
    const name = command.name.trim().toLowerCase()
    if (!name) continue
    if (lower === name || lower.startsWith(`${name} `) || lower.startsWith(`${name},`)) {
      const extra = tidy(text.slice(name.length).replace(/^[\s,]+/, ''))
      return { kind: 'saved', command, extra: EMPTY_EXTRA.test(extra) ? '' : extra }
    }
  }

  return { kind: 'write', instruction: text }
}

/** A saved command named like an action trigger could never run. */
export function reservedNameProblem(name: string): string | null {
  const lower = name.trim().toLowerCase()
  for (const trigger of [...OPEN_TRIGGERS, ...SEARCH_TRIGGERS]) {
    if (lower === trigger || lower.startsWith(`${trigger} `)) return `Names cannot start with "${trigger}": that phrase opens apps or searches the web.`
  }
  return null
}
