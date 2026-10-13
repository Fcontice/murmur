import { describe, expect, it } from 'vitest'
import type { AppContext, DictionaryEntry, Snippet, TextContext } from '@shared/types'
import { categorizeApp, isTerminal } from '../src/main/text/apps'
import { applyLineCommands, basicCleanup, countWords, removeFillers } from '../src/main/text/cleanup'
import { extractTrailingCommand } from '../src/main/text/commands'
import { applyDictionary, applySnippets } from '../src/main/text/dictionary'
import { isPlausibleCleanup, runPipeline } from '../src/main/text/pipeline'
import { fitToContext } from '../src/main/text/spacing'
import { tidyModelOutput } from '../src/main/llm/prompts'

const noContext: TextContext = { available: false, before: '', after: '', selected: '', isPassword: false }
const context = (before: string, after = '', selected = ''): TextContext => ({ available: true, before, after, selected, isPassword: false })
const formal = { category: 'other', style: 'formal' } as const

const entry = (phrase: string, heardAs: string[] = []): DictionaryEntry => ({ id: phrase, phrase, heardAs, createdAt: 0, uses: 0 })
const snippet = (trigger: string, expansion: string): Snippet => ({ id: trigger, trigger, expansion, createdAt: 0, uses: 0 })
const app = (category: AppContext['category'] = 'other'): AppContext => ({ name: 'Notepad', process: 'notepad', title: '', category, isTerminal: false })
const settings = {
  editingStrength: 'light',
  styles: { personal: 'casual', work: 'casual', email: 'formal', other: 'formal' },
  smartSpacing: true,
  voiceCommands: true,
} as const

describe('cleanup', () => {
  it('removes fillers and stutters without touching real words', () => {
    expect(removeFillers('Um, so I think, uh, the the plan is good')).toBe('so I think, the plan is good')
    expect(removeFillers('He had had enough of that that day')).toBe('He had had enough of that that day')
    expect(removeFillers('The umbrella is erm here')).toBe('The umbrella is here')
  })

  it('turns spoken line commands into line breaks', () => {
    expect(applyLineCommands('First point. New line. Second point')).toBe('First point\nSecond point')
    expect(applyLineCommands('Hi Sam, new paragraph thanks for the help')).toBe('Hi Sam\n\nthanks for the help')
  })

  it('capitalises sentence starts', () => {
    expect(basicCleanup('hello there. how are you', { voiceCommands: true, removeFillers: true })).toBe('Hello there. How are you')
  })

  it('counts words', () => {
    expect(countWords("It's a well-known 3 word-ish test")).toBe(6)
    expect(countWords('  ')).toBe(0)
  })
})

describe('dictionary and snippets', () => {
  it('fixes casing and misheard forms as whole words only', () => {
    const result = applyDictionary('we deploy on kubernetes with open ai and super base', [
      entry('Kubernetes'),
      entry('OpenAI', ['open ai']),
      entry('Supabase', ['super base', 'supa base']),
    ])
    expect(result.text).toBe('we deploy on Kubernetes with OpenAI and Supabase')
    expect(result.usedIds.sort()).toEqual(['Kubernetes', 'OpenAI', 'Supabase'])
    expect(applyDictionary('the openairport plan', [entry('OpenAI', ['open ai'])]).text).toBe('the openairport plan')
  })

  it('expands a snippet spoken on its own exactly', () => {
    const result = applySnippets('My address.', [snippet('my address', '12 Example Road\nLondon')])
    expect(result).toMatchObject({ whole: true, text: '12 Example Road\nLondon' })
  })

  it('expands a snippet inside a sentence', () => {
    const result = applySnippets('Book time at my calendar link please', [snippet('my calendar link', 'https://cal.example/me')])
    expect(result).toMatchObject({ whole: false, text: 'Book time at https://cal.example/me please' })
  })
})

describe('trailing commands', () => {
  it('detects press enter and keeps sentence punctuation', () => {
    expect(extractTrailingCommand('Sounds good to me. Press enter.')).toEqual({ text: 'Sounds good to me.', pressEnter: true })
    expect(extractTrailingCommand('what time is it press enter')).toEqual({ text: 'what time is it', pressEnter: true })
    expect(extractTrailingCommand('Then press enter to continue')).toEqual({ text: 'Then press enter to continue', pressEnter: false })
  })
})

describe('fitToContext', () => {
  it('adds a trailing space when nothing is known about the field', () => {
    expect(fitToContext('Hello there.', noContext, formal)).toBe('Hello there. ')
  })

  it('continues a sentence in lower case with a leading space', () => {
    expect(fitToContext('And then we left.', context('We ate dinner'), formal)).toBe(' and then we left. ')
  })

  it('keeps capitals that might be names', () => {
    expect(fitToContext('Sarah agreed.', context('I asked and'), formal)).toBe(' Sarah agreed. ')
    expect(fitToContext("I'm not sure.", context('Honestly,'), formal)).toBe(" I'm not sure. ")
  })

  it('starts a new sentence after a full stop', () => {
    expect(fitToContext('The second point.', context('First point.'), formal)).toBe(' The second point. ')
  })

  it('does not double the space when one is already there', () => {
    expect(fitToContext('Next thing.', context('Done. '), formal)).toBe('Next thing. ')
  })

  it('drops the full stop and trailing space when inserted before existing text', () => {
    expect(fitToContext('The quick fox.', context('', ' jumps over'), formal)).toBe('The quick fox')
    expect(fitToContext('Very.', context('It was ', 'good'), formal)).toBe('very ')
  })

  it('mirrors the whitespace of a replaced selection', () => {
    expect(fitToContext('New words.', context('a', 'b', ' old words '), formal)).toBe(' New words. ')
  })

  it('relaxes the full stop in casual chat', () => {
    expect(fitToContext('Sounds good.', noContext, { category: 'personal', style: 'casual' })).toBe('Sounds good ')
    expect(fitToContext('Sounds good.', noContext, { category: 'personal', style: 'formal' })).toBe('Sounds good. ')
    expect(fitToContext('One. Two. Three.', noContext, { category: 'work', style: 'casual' })).toBe('One. Two. Three. ')
  })
})

describe('apps', () => {
  it('classifies native apps and browser tabs', () => {
    expect(categorizeApp('Slack.exe', '')).toBe('work')
    expect(categorizeApp('chrome', 'Inbox (3) - me@example.com - Gmail')).toBe('email')
    expect(categorizeApp('msedge', 'WhatsApp')).toBe('personal')
    expect(categorizeApp('WindowsTerminal', 'pwsh')).toBe('developer')
    expect(categorizeApp('notepad', 'Untitled')).toBe('other')
    expect(isTerminal('pwsh.exe')).toBe(true)
  })
})

describe('model output handling', () => {
  it('strips wrappers and quotes', () => {
    expect(tidyModelOutput('<transcript>\nHello.\n</transcript>')).toBe('Hello.')
    expect(tidyModelOutput('"Hello there."')).toBe('Hello there.')
    expect(tidyModelOutput('She said "hi" and left.')).toBe('She said "hi" and left.')
  })

  it('rejects replies that are not a clean-up', () => {
    expect(isPlausibleCleanup('what is the capital of france', 'What is the capital of France?')).toBe(true)
    expect(isPlausibleCleanup('what is the capital of france', 'The capital of France is Paris, a city known for its art, culture, cuisine and the Eiffel Tower, which draws millions of visitors.')).toBe(false)
    expect(isPlausibleCleanup('so the three things we need are the budget the timeline and sign off from legal', 'Okay.')).toBe(false)
  })
})

describe('runPipeline', () => {
  const base = { settings, app: app(), textContext: noContext, dictionary: [], snippets: [] }

  it('works without a model', async () => {
    const out = await runPipeline({ ...base, raw: 'um hello there. this is a test' })
    expect(out).toMatchObject({ text: 'Hello there. This is a test ', usedLlm: false, pressEnter: false })
  })

  it('uses the model reply and then applies the dictionary', async () => {
    const out = await runPipeline({
      ...base,
      raw: 'um we use super base for auth',
      dictionary: [entry('Supabase', ['super base'])],
      complete: async () => 'We use super base for auth.',
    })
    expect(out).toMatchObject({ text: 'We use Supabase for auth. ', usedLlm: true, dictionaryIds: ['Supabase'] })
  })

  it('falls back when the model answers instead of cleaning', async () => {
    const out = await runPipeline({
      ...base,
      raw: 'what is two plus two',
      complete: async () => 'Two plus two equals four. This is a basic arithmetic fact that follows from the definition of addition on the natural numbers.',
    })
    expect(out).toMatchObject({ text: 'What is two plus two ', usedLlm: false, llmRejected: true })
  })

  it('falls back when the model throws', async () => {
    const out = await runPipeline({ ...base, raw: 'hello world', complete: async () => { throw new Error('offline') } })
    expect(out).toMatchObject({ text: 'Hello world ', usedLlm: false, llmRejected: true })
  })

  it('skips the model for verbatim and for whole-utterance snippets', async () => {
    let calls = 0
    const complete = async () => { calls++; return 'x' }
    const verbatim = await runPipeline({ ...base, settings: { ...settings, editingStrength: 'verbatim' }, raw: 'um hello', complete })
    expect(verbatim.text).toBe('Um hello ')
    const snip = await runPipeline({ ...base, raw: 'my email', snippets: [snippet('my email', 'me@example.com')], complete })
    expect(snip.text).toBe('me@example.com ')
    expect(calls).toBe(0)
  })

  it('reports press enter and strips the phrase', async () => {
    const out = await runPipeline({ ...base, raw: 'search for flights to lisbon press enter' })
    expect(out).toMatchObject({ text: 'Search for flights to lisbon ', pressEnter: true })
  })
})
