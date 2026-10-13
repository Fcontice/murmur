import type { EditingStrength, EngineStatus, Settings, StyleCategory, WritingStyle } from '@shared/types'
import { Section } from '../components'

interface Props {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<string | null>
  status: EngineStatus
}

const STRENGTHS: Array<{ value: EditingStrength; label: string; description: string }> = [
  { value: 'verbatim', label: 'Verbatim', description: 'Exactly what you said, with punctuation. No language model involved.' },
  { value: 'light', label: 'Light', description: 'Removes ums, repeats and false starts. Applies corrections like “no, actually Wednesday”.' },
  { value: 'medium', label: 'Medium', description: 'Also repairs grammar, breaks up run-on sentences and lays out spoken lists.' },
  { value: 'heavy', label: 'Heavy', description: 'Rewrites for clarity and brevity while keeping every fact and request.' },
]

const CATEGORIES: Array<{ id: StyleCategory; title: string; apps: string }> = [
  { id: 'personal', title: 'Personal messages', apps: 'WhatsApp, Telegram, Discord, Signal, Messenger' },
  { id: 'work', title: 'Work messages', apps: 'Slack, Teams, Zoom chat' },
  { id: 'email', title: 'Email', apps: 'Outlook, Gmail, Thunderbird' },
  { id: 'other', title: 'Everything else', apps: 'Documents, notes, browsers, code editors' },
]

const STYLES: Array<{ value: WritingStyle; label: string; summary: string }> = [
  { value: 'formal', label: 'Formal', summary: 'Capitals and full punctuation' },
  { value: 'casual', label: 'Casual', summary: 'Capitals, lighter punctuation' },
  { value: 'veryCasual', label: 'Very casual', summary: 'Lowercase, minimal punctuation' },
]

const EXAMPLES: Record<StyleCategory, Record<WritingStyle, string>> = {
  personal: {
    formal: 'Are you free for lunch on Saturday? I was thinking of that new ramen place.',
    casual: 'Are you free for lunch Saturday? Was thinking that new ramen place',
    veryCasual: 'are you free for lunch saturday? was thinking that new ramen place',
  },
  work: {
    formal: 'The numbers look good. I will share the full report after standup.',
    casual: "The numbers look good, I'll share the full report after standup",
    veryCasual: "numbers look good, i'll share the full report after standup",
  },
  email: {
    formal: 'Hi Dana,\n\nThank you for sending the draft. I will have comments back to you by Thursday.\n\nBest,\nAlex',
    casual: "Hi Dana,\n\nThanks for the draft! I'll get comments back to you by Thursday.\n\nBest,\nAlex",
    veryCasual: "hi dana,\n\nthanks for the draft, i'll get comments back by thursday\n\nalex",
  },
  other: {
    formal: 'Ran five kilometres this morning. My pace was slower than last week, but my knee felt fine.',
    casual: 'Ran 5k this morning. Pace was slower than last week but my knee felt fine',
    veryCasual: 'ran 5k this morning, pace was slower than last week but my knee felt fine',
  },
}

export function Style({ settings, update, status }: Props) {
  const modelOff = status.llm !== 'ready' && status.llm !== 'loading'

  return (
    <div className="page">
      <header className="page-header">
        <h1>Style</h1>
        <p>How much Murmur tidies what you say, and how the result should read in each kind of app.</p>
      </header>

      {modelOff && (
        <div className="banner">
          <div>Clean-up beyond Verbatim and per-app styles need a language model. {status.llmDetail}</div>
        </div>
      )}

      <Section title="Clean-up" description="Applies to every dictation.">
        <div className="choices">
          {STRENGTHS.map((strength) => (
            <button
              key={strength.value}
              type="button"
              className={`choice ${settings.editingStrength === strength.value ? 'selected' : ''}`}
              aria-pressed={settings.editingStrength === strength.value}
              onClick={() => void update({ editingStrength: strength.value })}
            >
              <span className="choice-title">{strength.label}</span>
              <span className="choice-body">{strength.description}</span>
            </button>
          ))}
        </div>
      </Section>

      {CATEGORIES.map((category) => (
        <Section key={category.id} title={category.title} description={category.apps}>
          <div className="choices three">
            {STYLES.map((style) => {
              const selected = settings.styles[category.id] === style.value
              return (
                <button
                  key={style.value}
                  type="button"
                  className={`choice ${selected ? 'selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => void update({ styles: { ...settings.styles, [category.id]: style.value } })}
                >
                  <span className="choice-title">{style.label}</span>
                  <span className="choice-body">{style.summary}</span>
                  <span className="choice-example">{EXAMPLES[category.id][style.value]}</span>
                </button>
              )
            })}
          </div>
        </Section>
      ))}
    </div>
  )
}
