import type { AppContext, DictionaryEntry, Settings, Snippet, TextContext } from '@shared/types'
import { buildFormatRequest, tidyModelOutput, type ChatRequest } from '../llm/prompts'
import { styleCategoryFor } from './apps'
import { basicCleanup, countWords, splitOnLineCommands } from './cleanup'
import { extractTrailingCommand } from './commands'
import { applyDictionary, applySnippets } from './dictionary'
import { fitToContext } from './spacing'

export type Complete = (request: ChatRequest) => Promise<string>

export interface PipelineInput {
  raw: string
  settings: Pick<Settings, 'editingStrength' | 'styles' | 'smartSpacing' | 'voiceCommands'>
  app: AppContext
  textContext: TextContext
  dictionary: DictionaryEntry[]
  snippets: Snippet[]
  /** Absent when no language model is configured or loaded. */
  complete?: Complete
}

export interface PipelineOutput {
  text: string
  pressEnter: boolean
  usedLlm: boolean
  llmMs: number
  /** The model replied, but with something that was not a clean-up of the input. */
  llmRejected: boolean
  dictionaryIds: string[]
  snippetIds: string[]
}

/**
 * A clean-up should stay close to the length of what was said. A reply far outside that range means
 * the model answered the dictation or wrote an essay, and the reply is discarded.
 */
export function isPlausibleCleanup(raw: string, cleaned: string): boolean {
  const rawWords = countWords(raw)
  const cleanedWords = countWords(cleaned)
  if (cleanedWords === 0) return rawWords <= 2
  if (cleanedWords > rawWords * 1.5 + 6) return false
  if (rawWords >= 8 && cleanedWords < rawWords * 0.3) return false
  return true
}

/** Long dictations are cleaned in pieces so each fits the model's context comfortably. */
export function splitForModel(text: string, maxWords = 300): string[] {
  if (countWords(text) <= maxWords) return [text]
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && countWords(current) + countWords(sentence) > maxWords) {
      chunks.push(current.trim())
      current = ''
    }
    current += sentence
    // A single unpunctuated run can exceed the limit on its own; cut it by words.
    while (countWords(current) > maxWords * 1.5) {
      const words = current.split(/\s+/)
      chunks.push(words.slice(0, maxWords).join(' '))
      current = words.slice(maxWords).join(' ')
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { settings, app } = input
  const output: PipelineOutput = {
    text: '', pressEnter: false, usedLlm: false, llmMs: 0, llmRejected: false, dictionaryIds: [], snippetIds: [],
  }

  let raw = input.raw.replace(/\s+/g, ' ').trim()
  if (!raw) return output

  if (settings.voiceCommands) {
    const command = extractTrailingCommand(raw)
    raw = command.text
    output.pressEnter = command.pressEnter
    if (!raw) return output
  }

  const style = settings.styles[styleCategoryFor(app.category)]
  const spacing = { category: app.category, style }
  const finish = (text: string) => (settings.smartSpacing ? fitToContext(text, input.textContext, spacing) : text.trim())

  // A snippet spoken on its own is inserted as written, without the model touching it.
  const wholeSnippet = applySnippets(raw, input.snippets)
  if (wholeSnippet.whole) {
    output.snippetIds = wholeSnippet.usedIds
    output.text = finish(wholeSnippet.text)
    return output
  }

  const verbatim = settings.editingStrength === 'verbatim'
  let text = basicCleanup(raw, { voiceCommands: settings.voiceCommands, removeFillers: !verbatim })

  if (!verbatim && input.complete) {
    const started = Date.now()
    try {
      const segments = settings.voiceCommands ? splitOnLineCommands(raw) : [{ text: raw, breakAfter: '' as const }]
      let reply = ''
      for (const segment of segments) {
        const cleaned: string[] = []
        for (const chunk of splitForModel(segment.text)) {
          const piece = tidyModelOutput(
            await input.complete(
              buildFormatRequest({
                transcript: chunk,
                style,
                strength: settings.editingStrength === 'verbatim' ? 'light' : settings.editingStrength,
                category: app.category,
                appName: app.name,
                vocabulary: input.dictionary.map((entry) => entry.phrase).slice(0, 200),
              }),
            ),
          )
          // One bad piece spoils the whole result, so the check is per piece.
          if (!isPlausibleCleanup(chunk, piece)) throw new Error('implausible reply')
          cleaned.push(piece)
        }
        reply += cleaned.join(' ') + segment.breakAfter
      }
      text = reply.trim()
      output.usedLlm = true
    } catch {
      // Fall through with the deterministic clean-up; dictation must still land.
      output.llmRejected = true
    }
    output.llmMs = Date.now() - started
  }

  const withDictionary = applyDictionary(text, input.dictionary)
  const withSnippets = applySnippets(withDictionary.text, input.snippets)
  output.dictionaryIds = withDictionary.usedIds
  output.snippetIds = withSnippets.usedIds
  output.text = finish(withSnippets.text)
  return output
}
