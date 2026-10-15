import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MAX_COMMAND_NAME, MAX_PROMPT, MAX_SITE_NAME, MAX_URL, SEARCH_ENGINES } from '@shared/settings'
import type { SavedCommand, Settings, Site } from '@shared/types'
import { Empty, Keys, Row, Segmented } from '../components'
import { errorMessage } from '../hooks'

const api = window.gloopVoice
const CUSTOM = 'Custom'

interface Props {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<string | null>
}

function Examples({ command }: { command?: SavedCommand }) {
  const examples: Array<[string, string]> = [
    ['open Spotify', 'Opens an installed app.'],
    ['go to github.com', 'Opens a site in your browser.'],
    ['search for standing desks', 'Searches the web.'],
    ['reply to this', 'Writes a reply to what is selected or on screen.'],
  ]
  if (command && !examples.some(([phrase]) => phrase.toLowerCase() === command.name.toLowerCase())) examples.push([command.name, 'Runs your saved command.'])
  return (
    <section className="section">
      <header>
        <h2>Try saying</h2>
      </header>
      <div className="card list">
        {examples.map(([phrase, meaning]) => (
          <div key={phrase} className="list-row inline">
            <div className="list-text strong">“{phrase}”</div>
            <span className="list-meta">{meaning}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SavedCommands({ commands, loadError, refresh }: { commands: SavedCommand[]; loadError: string | null; refresh: () => void }) {
  const nameInput = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (loadError) setError(loadError)
  }, [loadError])

  const reset = () => {
    setEditing(null)
    setName('')
    setPrompt('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api.saveCommand({ id: editing ?? undefined, name, prompt })
      reset()
      refresh()
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  return (
    <section className="section">
      <header>
        <h2>Saved commands</h2>
        <p>Say a command's name to run its instruction on the selected text, or on what's on screen when nothing is selected.</p>
      </header>

      <form className="card form" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input ref={nameInput} className="input" value={name} maxLength={MAX_COMMAND_NAME} placeholder="Spanish" onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Instruction <span className="optional">{prompt.length}/{MAX_PROMPT}</span>
          <textarea className="input" rows={3} value={prompt} maxLength={MAX_PROMPT} placeholder="Translate this into Spanish." onChange={(event) => setPrompt(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={!name.trim() || !prompt.trim()}>
            {editing ? 'Save changes' : 'Add command'}
          </button>
          {editing && (
            <button type="button" className="button ghost" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {commands.length === 0 ? (
        <Empty title="No saved commands">Good first ones: a translation, a summary, a polite rewrite.</Empty>
      ) : (
        <div className="card list">
          {commands.map((command) => (
            <div key={command.id} className="list-row inline">
              <div>
                <div className="list-text strong">“{command.name}”</div>
                <div className="list-meta clamp">{command.prompt}</div>
              </div>
              <span className="list-actions">
                {command.uses > 0 && <span className="list-meta">Used {command.uses}×</span>}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setEditing(command.id)
                    setName(command.name)
                    setPrompt(command.prompt)
                    setError(null)
                    nameInput.current?.focus()
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={async () => {
                    try {
                      await api.deleteCommand(command.id)
                      if (editing === command.id) reset()
                      refresh()
                    } catch (problem) {
                      setError(errorMessage(problem))
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Sites() {
  const nameInput = useRef<HTMLInputElement>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => void api.listSites().then(setSites, (problem: unknown) => setError(errorMessage(problem)))
  useEffect(refresh, [])

  const reset = () => {
    setEditing(null)
    setName('')
    setUrl('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api.saveSite({ id: editing ?? undefined, name, url })
      reset()
      refresh()
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  return (
    <section className="section">
      <header>
        <h2>Sites</h2>
        <p>Say “open” and a name to open a site. Installed apps open by name without adding them here.</p>
      </header>

      <form className="card form" onSubmit={(event) => void submit(event)}>
        <label>
          Name
          <input ref={nameInput} className="input" value={name} maxLength={MAX_SITE_NAME} placeholder="Gmail" onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Address
          <input className="input" value={url} maxLength={MAX_URL} placeholder="mail.google.com" onChange={(event) => setUrl(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={!name.trim() || !url.trim()}>
            {editing ? 'Save changes' : 'Add site'}
          </button>
          {editing && (
            <button type="button" className="button ghost" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {sites.length === 0 ? (
        <Empty title="No sites yet">Add the sites you open every day, like your email or calendar.</Empty>
      ) : (
        <div className="card list">
          {sites.map((site) => (
            <div key={site.id} className="list-row inline">
              <div>
                <div className="list-text strong">{site.name}</div>
                <div className="list-meta">{site.url}</div>
              </div>
              <span className="list-actions">
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setEditing(site.id)
                    setName(site.name)
                    setUrl(site.url)
                    setError(null)
                    nameInput.current?.focus()
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={async () => {
                    try {
                      await api.deleteSite(site.id)
                      if (editing === site.id) reset()
                      refresh()
                    } catch (problem) {
                      setError(errorMessage(problem))
                    }
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function WebSearch({ settings, update }: Props) {
  const preset = SEARCH_ENGINES.find((engine) => engine.url === settings.searchUrl)
  // True only after Custom is clicked and before a custom address is saved. Otherwise the saved setting decides.
  const [custom, setCustom] = useState(false)
  const [draft, setDraft] = useState(preset ? '' : settings.searchUrl)
  const [error, setError] = useState<string | null>(null)
  const selected = custom || !preset ? CUSTOM : preset.name

  useEffect(() => {
    if (!SEARCH_ENGINES.some((engine) => engine.url === settings.searchUrl)) setDraft(settings.searchUrl)
  }, [settings.searchUrl])

  const choose = async (choice: string) => {
    setError(null)
    if (choice === CUSTOM) {
      if (preset) setDraft(preset.url)
      setCustom(true)
      return
    }
    const engine = SEARCH_ENGINES.find((item) => item.name === choice)
    if (!engine) return
    setCustom(false)
    setError(await update({ searchUrl: engine.url }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problem = await update({ searchUrl: draft })
    setError(problem)
    if (!problem) setCustom(false)
  }

  return (
    <section className="section">
      <header>
        <h2>Web search</h2>
        <p>Used when you say “search for” something, or open a name that matches no app or site.</p>
      </header>
      <div className="card">
        <Row title="Search with" description={selected !== CUSTOM && error ? <span className="form-error">{error}</span> : undefined}>
          <Segmented
            label="Search with"
            value={selected}
            options={[...SEARCH_ENGINES.map((engine) => ({ value: engine.name, label: engine.name })), { value: CUSTOM, label: CUSTOM }]}
            onChange={(value) => void choose(value)}
          />
        </Row>
        {selected === CUSTOM && (
          <form className="form" onSubmit={(event) => void submit(event)}>
            <label>
              Search address <span className="optional">{'{query}'} marks where the search terms go</span>
              <input className="input" value={draft} placeholder="https://example.com/search?q={query}" onChange={(event) => setDraft(event.target.value)} />
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="form-actions">
              <button type="submit" className="button primary" disabled={!draft.trim() || draft.trim() === settings.searchUrl}>
                Save
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  )
}

export function Commands({ settings, update }: Props) {
  const [commands, setCommands] = useState<SavedCommand[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // Loaded here, not in SavedCommands, because the examples card also names the first saved command.
  const refresh = () =>
    void api.listCommands().then(
      (list) => {
        setCommands(list)
        setLoadError(null)
      },
      (problem: unknown) => setLoadError(errorMessage(problem)),
    )
  useEffect(refresh, [])

  return (
    <div className="page">
      <header className="page-header">
        <h1>Commands</h1>
        <p>
          Hold <Keys keys={settings.shortcuts.command} /> and say what to do.
        </p>
      </header>

      <Examples command={commands[0]} />
      <SavedCommands commands={commands} loadError={loadError} refresh={refresh} />
      <Sites />
      <WebSearch settings={settings} update={update} />
    </div>
  )
}
