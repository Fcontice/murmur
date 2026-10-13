import type { AppCategory, TextContext, WritingStyle } from '@shared/types'

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const CJK = /[　-ヿ㐀-鿿＀-￯]/
// After these, typed text continues with a space.
const SPACE_AFTER = /[\p{L}\p{N}!%),.:;>?\]}"'”’]/u
// Trailing characters to look through when deciding whether the caret sits mid-sentence.
const SOFT_TRAIL = /[\s,;:\-–—(["'“‘]+$/u

// Lower-casing is limited to words that are never proper nouns, so a dictated name keeps its capital.
const SAFE_TO_LOWERCASE = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'because', 'if', 'when', 'while', 'then', 'that', 'this', 'these',
  'those', 'there', 'here', 'it', 'we', 'you', 'he', 'she', 'they', 'my', 'our', 'your', 'his', 'her', 'their', 'its',
  'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'no', 'yes',
  'also', 'just', 'please', 'can', 'could', 'will', 'would', 'should', 'do', 'does', 'did', 'have', 'has', 'had',
  'what', 'how', 'why', 'where', 'which', 'who', 'let', "let's", 'maybe', 'okay', 'ok', 'well', 'actually', 'however',
  'which', 'after', 'before', 'until', 'since', 'though', 'although', 'unless', 'once', 'like', 'about', 'some', 'any',
  'all', 'each', 'every', 'more', 'most', 'very', 'really', 'still', 'even', 'only', 'thanks', 'thank',
])

export interface SpacingOptions {
  category: AppCategory
  style: WritingStyle
}

function firstWord(text: string): string {
  return /^[\p{L}'’]+/u.exec(text)?.[0] ?? ''
}

function isMidSentence(before: string): boolean {
  const core = before.replace(SOFT_TRAIL, '')
  const last = core.at(-1)
  return last !== undefined && LETTER_OR_DIGIT.test(last)
}

function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim()).length
}

/** Chat messages read oddly with a full stop on a one-liner. */
export function relaxTrailingPeriod(text: string, options: SpacingOptions): string {
  const messaging = options.category === 'personal' || options.category === 'work'
  if (!messaging || options.style === 'formal') return text
  if (!/[^.]\.$/.test(text) || text.includes('\n')) return text
  const limit = options.style === 'veryCasual' ? Infinity : 2
  return sentenceCount(text) <= limit ? text.slice(0, -1) : text
}

/**
 * Fits dictated text into whatever surrounds the caret: leading and trailing spaces, the capital on
 * the first word, and the final full stop.
 */
export function fitToContext(text: string, context: TextContext, options: SpacingOptions): string {
  let out = relaxTrailingPeriod(text.trim(), options)
  if (!out) return out
  const multiline = out.includes('\n')

  if (!context.available) {
    return multiline || CJK.test(out.at(-1) ?? '') ? out : `${out} `
  }

  if (context.selected) {
    // Replacing a selection: keep the whitespace the selection carried and nothing else.
    const lead = /^\s+/.exec(context.selected)?.[0] ?? ''
    const trail = /\s+$/.exec(context.selected)?.[0] ?? ''
    return lead + out + trail
  }

  const before = context.before
  const after = context.after
  const currentLine = before.slice(before.lastIndexOf('\n') + 1)

  if (isMidSentence(currentLine)) {
    const word = firstWord(out)
    if (word && SAFE_TO_LOWERCASE.has(word.toLowerCase()) && word !== 'I' && !word.startsWith("I'") && !word.startsWith('I’')) {
      out = out[0]!.toLowerCase() + out.slice(1)
    }
  }

  const next = after[0]
  if (next !== undefined && !multiline && /[.!?]$/.test(out) && /^[ \t]*[\p{Ll},.;:!?)]/u.test(after)) {
    out = out.replace(/[.!?]+$/, '')
  }

  const previous = currentLine.at(-1)
  if (previous !== undefined && SPACE_AFTER.test(previous) && !CJK.test(previous) && !/^[\s,.;:!?)]/.test(out)) {
    out = ` ${out}`
  }

  const last = out.at(-1) ?? ''
  const needsTrailingSpace = next === undefined || next === '\n' || next === '\r' || LETTER_OR_DIGIT.test(next)
  if (needsTrailingSpace && !multiline && !CJK.test(last) && !/\s$/.test(out)) out = `${out} `

  return out
}
