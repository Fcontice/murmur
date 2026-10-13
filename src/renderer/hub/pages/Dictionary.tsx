import { useEffect, useState, type FormEvent } from 'react'
import type { DictionaryEntry } from '@shared/types'
import { Empty } from '../components'
import { errorMessage } from '../hooks'

const api = window.murmur

export function Dictionary() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [phrase, setPhrase] = useState('')
  const [heardAs, setHeardAs] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => void api.listDictionary().then(setEntries)
  useEffect(refresh, [])

  const reset = () => {
    setEditing(null)
    setPhrase('')
    setHeardAs('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api.saveDictionaryEntry({ id: editing ?? undefined, phrase, heardAs: heardAs.split(',') })
      reset()
      refresh()
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  const edit = (entry: DictionaryEntry) => {
    setEditing(entry.id)
    setPhrase(entry.phrase)
    setHeardAs(entry.heardAs.join(', '))
    setError(null)
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dictionary</h1>
        <p>Names, jargon and spellings Murmur should get right. Add how a word gets misheard and it is corrected every time.</p>
      </header>

      <form className="card form" onSubmit={(event) => void submit(event)}>
        <label>
          Word or phrase
          <input className="input" value={phrase} maxLength={80} placeholder="Supabase" onChange={(event) => setPhrase(event.target.value)} />
        </label>
        <label>
          Often heard as <span className="optional">optional, comma-separated</span>
          <input className="input" value={heardAs} maxLength={240} placeholder="super base, supa bass" onChange={(event) => setHeardAs(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={!phrase.trim()}>
            {editing ? 'Save changes' : 'Add to dictionary'}
          </button>
          {editing && (
            <button type="button" className="button ghost" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {entries.length === 0 ? (
        <Empty title="Your dictionary is empty">Add a colleague's name, a product, or an acronym to start.</Empty>
      ) : (
        <div className="card list">
          {entries.map((entry) => (
            <div key={entry.id} className="list-row inline">
              <div>
                <div className="list-text strong">{entry.phrase}</div>
                {entry.heardAs.length > 0 && <div className="list-meta">Corrects: {entry.heardAs.join(', ')}</div>}
              </div>
              <span className="list-actions">
                {entry.uses > 0 && <span className="list-meta">Used {entry.uses}×</span>}
                <button type="button" className="link" onClick={() => edit(entry)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={async () => {
                    await api.deleteDictionaryEntry(entry.id)
                    if (editing === entry.id) reset()
                    refresh()
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
