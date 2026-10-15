import { useEffect, useState, type FormEvent } from 'react'
import type { Snippet } from '@shared/types'
import { Empty } from '../components'
import { errorMessage } from '../hooks'

const api = window.gloopVoice
const MAX_EXPANSION = 4000

export function Snippets() {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [trigger, setTrigger] = useState('')
  const [expansion, setExpansion] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => void api.listSnippets().then(setSnippets)
  useEffect(refresh, [])

  const reset = () => {
    setEditing(null)
    setTrigger('')
    setExpansion('')
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api.saveSnippet({ id: editing ?? undefined, trigger, expansion })
      reset()
      refresh()
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Snippets</h1>
        <p>Say a short phrase and Gloop Voice inserts the longer text you saved: an address, a link, a standard reply.</p>
      </header>

      <form className="card form" onSubmit={(event) => void submit(event)}>
        <label>
          When I say
          <input className="input" value={trigger} maxLength={60} placeholder="my calendar link" onChange={(event) => setTrigger(event.target.value)} />
        </label>
        <label>
          Insert <span className="optional">{expansion.length}/{MAX_EXPANSION}</span>
          <textarea className="input" rows={4} value={expansion} maxLength={MAX_EXPANSION} placeholder="https://cal.example.com/me" onChange={(event) => setExpansion(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={!trigger.trim() || !expansion.trim()}>
            {editing ? 'Save changes' : 'Add snippet'}
          </button>
          {editing && (
            <button type="button" className="button ghost" onClick={reset}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {snippets.length === 0 ? (
        <Empty title="No snippets yet">Good first ones: your email address, a meeting link, a sign-off.</Empty>
      ) : (
        <div className="card list">
          {snippets.map((snippet) => (
            <div key={snippet.id} className="list-row inline">
              <div>
                <div className="list-text strong">“{snippet.trigger}”</div>
                <div className="list-meta clamp">{snippet.expansion}</div>
              </div>
              <span className="list-actions">
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setEditing(snippet.id)
                    setTrigger(snippet.trigger)
                    setExpansion(snippet.expansion)
                    setError(null)
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="link danger"
                  onClick={async () => {
                    await api.deleteSnippet(snippet.id)
                    if (editing === snippet.id) reset()
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
