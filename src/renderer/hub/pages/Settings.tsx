import { useEffect, useState } from 'react'
import type { AppInfo, TestResult } from '@shared/api'
import { sameKeys, DEFAULT_SHORTCUTS } from '@shared/settings'
import type { EngineStatus, ModelStatus, Settings, ShortcutAction } from '@shared/types'
import { Keys, ModelRow, Row, Section, Segmented, Toggle } from '../components'
import { errorMessage } from '../hooks'
import { MicPicker } from '../MicPicker'

const api = window.gloopVoice

interface Props {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<string | null>
  status: EngineStatus
  models: ModelStatus[]
}

const SHORTCUTS: Array<{ action: ShortcutAction; title: string; description: string }> = [
  { action: 'ptt', title: 'Dictate', description: 'Hold to talk, release to insert. Double-tap to lock.' },
  { action: 'handsFree', title: 'Hands-free', description: 'Press once to start, again to finish.' },
  { action: 'command', title: 'Command mode', description: 'Hold and say what to do: edit the selection, open an app or site, or search the web.' },
  { action: 'pasteLast', title: 'Paste last dictation', description: 'Inserts the most recent result again.' },
  { action: 'cancel', title: 'Cancel', description: 'Only active while recording.' },
]

const LANGUAGES: Array<[string, string]> = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['sv', 'Swedish'],
  ['tr', 'Turkish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['hi', 'Hindi'], ['ar', 'Arabic'],
]

function ShortcutRow({ action, title, description, settings, update }: (typeof SHORTCUTS)[number] & Pick<Props, 'settings' | 'update'>) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keys = settings.shortcuts[action]

  const record = async () => {
    setError(null)
    setRecording(true)
    const chord = await api.recordShortcut()
    setRecording(false)
    if (!chord) return
    setError(await update({ shortcuts: { ...settings.shortcuts, [action]: chord } }))
  }

  // Leaving the page mid-recording must hand the keyboard back.
  useEffect(() => () => void (recording && api.stopRecordingShortcut()), [recording])

  return (
    <Row title={title} description={error ? <span className="form-error">{error}</span> : description}>
      {recording ? <span className="recording">Press the keys, then release…</span> : <Keys keys={keys} />}
      {recording ? (
        <button type="button" className="button ghost" onClick={() => void api.stopRecordingShortcut()}>
          Cancel
        </button>
      ) : (
        <button type="button" className="button" onClick={() => void record()}>
          Change
        </button>
      )}
      {!recording && !sameKeys(keys, DEFAULT_SHORTCUTS[action]) && (
        <button type="button" className="button ghost" onClick={() => void api.resetShortcut(action).then(() => setError(null), (problem) => setError(errorMessage(problem)))}>
          Reset
        </button>
      )}
    </Row>
  )
}

function RemoteFields({ value, onChange, modelPlaceholder }: { value: Settings['llmRemote']; onChange: (next: Settings['llmRemote']) => void; modelPlaceholder: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft.baseUrl !== value.baseUrl || draft.apiKey !== value.apiKey || draft.model !== value.model) onChange(draft)
  }
  return (
    <div className="remote">
      <label>
        Endpoint URL
        <input className="input" value={draft.baseUrl} placeholder="http://localhost:11434/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value.trim() })} onBlur={commit} />
      </label>
      <label>
        Model
        <input className="input" value={draft.model} placeholder={modelPlaceholder} onChange={(event) => setDraft({ ...draft, model: event.target.value.trim() })} onBlur={commit} />
      </label>
      <label>
        API key <span className="optional">leave empty for local servers</span>
        <input className="input" type="password" value={draft.apiKey} autoComplete="off" onChange={(event) => setDraft({ ...draft, apiKey: event.target.value.trim() })} onBlur={commit} />
      </label>
    </div>
  )
}

export function SettingsPage({ settings, update, status, models }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [llmTest, setLlmTest] = useState<TestResult | 'running' | null>(null)
  useEffect(() => void api.getAppInfo().then(setInfo), [])

  const asrModels = models.filter((model) => model.kind === 'asr')
  const llmModels = models.filter((model) => model.kind === 'llm')
  const gpuPack = models.find((model) => model.id === 'llama-cuda')
  const selectedAsr = asrModels.find((model) => model.id === settings.asrModel)
  const languageApplies = settings.asrProvider === 'remote' || settings.asrModel.startsWith('whisper')

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
      </header>

      <Section title="Shortcuts" description="Shortcuts work in every app while Gloop Voice is running.">
        {SHORTCUTS.map((shortcut) => (
          <ShortcutRow key={shortcut.action} {...shortcut} settings={settings} update={update} />
        ))}
      </Section>

      <Section title="Microphone">
        <MicPicker value={settings.microphoneId} onChange={(deviceId) => void update({ microphoneId: deviceId })} />
        <Row title="Keep microphone ready" description="Starts recording instantly, so the first word is never clipped. Windows shows the microphone as in use the whole time.">
          <Toggle label="Keep microphone ready" checked={settings.keepMicWarm} onChange={(value) => void update({ keepMicWarm: value })} />
        </Row>
      </Section>

      <Section title="Speech recognition" description={<StatusLine state={status.asr} detail={status.asrDetail} />}>
        <Row title="Where speech is transcribed" description="On this computer, nothing you say leaves it.">
          <Segmented
            value={settings.asrProvider}
            options={[{ value: 'local', label: 'This computer' }, { value: 'remote', label: 'Custom server' }]}
            onChange={(value) => void update({ asrProvider: value })}
          />
        </Row>
        {settings.asrProvider === 'local' ? (
          asrModels.map((model) => <ModelRow key={model.id} model={model} selected={model.id === settings.asrModel} onSelect={() => void update({ asrModel: model.id })} />)
        ) : (
          <>
            <div className="row-description pad">Audio is sent to this server. Any service with an OpenAI-compatible <code>/audio/transcriptions</code> endpoint works.</div>
            <RemoteFields value={settings.asrRemote} modelPlaceholder="whisper-1" onChange={(next) => void update({ asrRemote: next })} />
          </>
        )}
        <Row
          title="Language"
          description={languageApplies ? 'Setting the language you speak improves accuracy.' : `${selectedAsr?.name ?? 'This model'} detects the language itself.`}
        >
          <select className="input" disabled={!languageApplies} value={settings.language} onChange={(event) => void update({ language: event.target.value })} aria-label="Language">
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="AI clean-up" description={<StatusLine state={status.llm} detail={status.llmDetail} />}>
        <Row title="Language model" description="Removes fillers, applies corrections and styles the text. Also powers command mode.">
          <Segmented
            value={settings.llmProvider}
            options={[{ value: 'local', label: 'This computer' }, { value: 'remote', label: 'Custom server' }, { value: 'off', label: 'Off' }]}
            onChange={(value) => {
              setLlmTest(null)
              void update({ llmProvider: value })
            }}
          />
        </Row>
        {settings.llmProvider === 'local' &&
          llmModels.map((model) => <ModelRow key={model.id} model={model} selected={model.id === settings.llmModel} onSelect={() => void update({ llmModel: model.id })} />)}
        {settings.llmProvider === 'local' && gpuPack && (info?.nvidiaGpu || gpuPack.installed) && <ModelRow model={gpuPack} />}
        {settings.llmProvider === 'remote' && (
          <>
            <div className="row-description pad">
              Transcripts are sent to this server. Works with Ollama, LM Studio, llama.cpp or any OpenAI-compatible <code>/chat/completions</code> endpoint.
            </div>
            <RemoteFields value={settings.llmRemote} modelPlaceholder="gemma3:4b" onChange={(next) => void update({ llmRemote: next })} />
            <div className="pad test">
              <button
                type="button"
                className="button"
                disabled={llmTest === 'running'}
                onClick={async () => {
                  setLlmTest('running')
                  setLlmTest(await api.testLlm())
                }}
              >
                {llmTest === 'running' ? 'Testing…' : 'Test connection'}
              </button>
              {llmTest && llmTest !== 'running' && <span className={llmTest.ok ? 'installed' : 'form-error'}>{llmTest.ok ? llmTest.message : `Failed: ${llmTest.message}`}</span>}
            </div>
          </>
        )}
      </Section>

      <Section title="Dictation">
        <Row title="Smart spacing" description="Adds the space before and after, and continues a sentence in lower case when you dictate mid-line.">
          <Toggle label="Smart spacing" checked={settings.smartSpacing} onChange={(value) => void update({ smartSpacing: value })} />
        </Row>
        <Row title="Voice commands" description="“New line”, “new paragraph”, and “press enter” at the end to send.">
          <Toggle label="Voice commands" checked={settings.voiceCommands} onChange={(value) => void update({ voiceCommands: value })} />
        </Row>
        <Row title="App awareness" description="Reads which app is focused and the text around the cursor to pick the style and spacing, and the window's text for commands. Never stored.">
          <Toggle label="App awareness" checked={settings.useAppContext} onChange={(value) => void update({ useAppContext: value })} />
        </Row>
        <Row title="Sounds" description="Short cues when recording starts and stops.">
          <Toggle label="Sounds" checked={settings.sounds} onChange={(value) => void update({ sounds: value })} />
        </Row>
        <Row title="Show the bar when idle" description="A small handle at the bottom of the screen. It always appears while recording.">
          <Toggle label="Show the bar when idle" checked={settings.showPillWhenIdle} onChange={(value) => void update({ showPillWhenIdle: value })} />
        </Row>
      </Section>

      <Section title="Inserting text">
        <Row title="Method" description="Paste is fastest and keeps formatting. Typing works in the few apps that block pasting.">
          <Segmented
            value={settings.pasteMethod}
            options={[{ value: 'clipboard', label: 'Paste' }, { value: 'type', label: 'Type' }]}
            onChange={(value) => void update({ pasteMethod: value })}
          />
        </Row>
        <Row title="Restore my clipboard" description="Puts back whatever you had copied once the text is in.">
          <Toggle label="Restore my clipboard" checked={settings.restoreClipboard} onChange={(value) => void update({ restoreClipboard: value })} />
        </Row>
        <Row title="Restore delay" description="Raise this if an app pastes your old clipboard instead of the dictation.">
          <select className="input" value={settings.clipboardRestoreDelayMs} onChange={(event) => void update({ clipboardRestoreDelayMs: Number(event.target.value) })} aria-label="Restore delay">
            {[200, 350, 600, 1000, 2000].map((ms) => (
              <option key={ms} value={ms}>{ms} ms</option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="Privacy and data">
        <Row title="Save history" description="Keeps what you dictate so you can search and copy it later. Word counts are kept either way.">
          <Toggle label="Save history" checked={settings.saveHistory} onChange={(value) => void update({ saveHistory: value })} />
        </Row>
        <Row title="Delete history automatically">
          <select className="input" value={settings.historyRetentionDays} onChange={(event) => void update({ historyRetentionDays: Number(event.target.value) })} aria-label="Delete history automatically">
            <option value={0}>Never</option>
            <option value={1}>After 1 day</option>
            <option value={7}>After 7 days</option>
            <option value={30}>After 30 days</option>
            <option value={90}>After 90 days</option>
          </select>
        </Row>
        <Row title="Data folder" description={info?.dataDir}>
          <button type="button" className="button" onClick={() => void api.openDataFolder()}>
            Open folder
          </button>
        </Row>
      </Section>

      <Section title="App">
        <Row title="Start with Windows" description="Runs quietly in the tray after you sign in.">
          <Toggle label="Start with Windows" checked={settings.launchAtLogin} onChange={(value) => void update({ launchAtLogin: value })} />
        </Row>
        <Row title="Version">
          <span className="row-description">{info?.version}</span>
        </Row>
      </Section>
    </div>
  )
}

function StatusLine({ state, detail }: { state: string; detail: string }) {
  const tone = state === 'ready' ? 'ok' : state === 'loading' ? 'busy' : state === 'off' ? 'off' : 'bad'
  return (
    <span className="status-line">
      <span className={`status-dot ${tone}`} />
      {detail || state}
    </span>
  )
}
