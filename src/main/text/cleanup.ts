/**
 * Deterministic clean-up. It runs on its own when no language model is available, and as a safety
 * net when the model's output is rejected.
 */

const FILLERS = /(^|[\s,])(?:u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h+m+)(?=[\s,.!?]|$)[,]?/gi

// Only words that are never legitimately doubled, so "had had" and "that that" survive.
const STUTTER = /\b(the|a|an|to|of|and|in|is|it|we|you|for|on|at|with|my|i)(\s+\1)+\b/gi

const LINE_COMMANDS: Array<[RegExp, string]> = [
  [/[,.;:]?\s*\bnew paragraph\b[,.;:]?\s*/gi, '\n\n'],
  [/[,.;:]?\s*\b(?:new line|newline|next line)\b[,.;:]?\s*/gi, '\n'],
]

export function removeFillers(text: string): string {
  return text
    .replace(FILLERS, '$1')
    .replace(STUTTER, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,{2,}/g, ',')
    .replace(/^[\s,]+/, '')
    .trim()
}

export function applyLineCommands(text: string): string {
  let out = text
  for (const [pattern, replacement] of LINE_COMMANDS) out = out.replace(pattern, replacement)
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim()
}

export interface SpokenSegment {
  text: string
  /** The line break the speaker asked for after this segment, if any. */
  breakAfter: '' | '\n' | '\n\n'
}

/**
 * Cuts a transcript at spoken line commands. The model cleans each piece on its own and the breaks
 * are put back afterwards, so a line break never depends on the model reproducing it.
 */
export function splitOnLineCommands(text: string): SpokenSegment[] {
  const pattern = /[,.;:]?\s*\b(new paragraph|new line|newline|next line)\b[,.;:]?\s*/gi
  const segments: SpokenSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const piece = text.slice(cursor, match.index).trim()
    const breakAfter = match[1]!.toLowerCase() === 'new paragraph' ? '\n\n' : '\n'
    if (piece) segments.push({ text: piece, breakAfter })
    else if (segments.length > 0) segments.at(-1)!.breakAfter = breakAfter
    cursor = match.index + match[0].length
  }
  const rest = text.slice(cursor).trim()
  if (rest) segments.push({ text: rest, breakAfter: '' })
  return segments
}

export function capitalizeSentences(text: string): string {
  return text.replace(/(^|[.!?]\s+|\n)(\p{Ll})/gu, (_, lead: string, letter: string) => lead + letter.toUpperCase())
}

export interface CleanupOptions {
  voiceCommands: boolean
  removeFillers: boolean
}

export function basicCleanup(raw: string, options: CleanupOptions): string {
  let text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (options.removeFillers) text = removeFillers(text)
  if (options.voiceCommands) text = applyLineCommands(text)
  return capitalizeSentences(text)
}

export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
  return matches ? matches.length : 0
}
